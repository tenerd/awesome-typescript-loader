import * as ts from 'typescript';
import * as path from 'path';
import * as micromatch from 'micromatch';
import * as colors from 'colors';
import { findResultFor, toUnix, noop, notImplemented, unorderedRemoveItem } from '../helpers';
import {
    Req,
    Res,
    LoaderConfig,
    Init,
    EmitFile,
    UpdateFile,
    Diagnostics,
    RemoveFile,
    Files,
    MessageType,
    TsConfig
} from './protocol';

import { CaseInsensitiveMap } from './fs';
import { isCaseInsensitive } from '../helpers';

const caseInsensitive = isCaseInsensitive();

if (!module.parent) {
    process.on('uncaughtException', function (err) {
        console.log("UNCAUGHT EXCEPTION in awesome-typescript-loader");
        console.log("[Inside 'uncaughtException' event] ", err.message, err.stack);
    });

    process.on('disconnect', function () {
        process.exit();
    });

    process.on('exit', () => {
        // console.log('EXIT RUNTIME');
    });

    createChecker(
        process.on.bind(process, 'message'),
        process.send.bind(process)
    );
} else {
    module.exports.run = function run() {
        let send: (msg: Req, cb: (err?: Error) => void) => void;
        let receive = (msg) => { };

        createChecker(
            (receive: (msg: Req) => void) => {
                send = (msg: Req, cb: (err?: Error) => void) => {
                    receive(msg);
                    if (cb) { cb(); }
                };
            },
            (msg) => receive(msg)
        );

        return {
            on: (type: string, cb) => {
                if (type === 'message') {
                    receive = cb;
                }
            },
            send,
            kill: () => { }
        };
    };
}

interface File {
    fileName: string;
    text: string;
}

type Filter = (file: ts.SourceFile) => boolean;

function createChecker(receive: (cb: (msg: Req) => void) => void, send: (msg: Res) => void) {
    let loaderConfig: LoaderConfig;
    let compilerConfig: TsConfig;
    let compilerOptions: ts.CompilerOptions;
    let compiler: typeof ts;
    let files = new CaseInsensitiveMap<File>();
    let ignoreDiagnostics: { [id: number]: boolean } = {};
    let instanceName: string;
    let context: string;
    let rootFilesChanged = false;

    let system: ts.System;
    let filesRegex: RegExp;
    type WatchCallbacks<T> = Map<string, T[]>;
    const watchedFiles: WatchCallbacks<ts.FileWatcherCallback> = new Map();
    const watchedDirectories: WatchCallbacks<ts.DirectoryWatcherCallback> = new Map();
    const watchedDirectoriesRecursive: WatchCallbacks<ts.DirectoryWatcherCallback> = new Map();
    const getCanonicalFileName: (fileName: string) => string = caseInsensitive ?
        fileName => fileName.toLowerCase() :
        (fileName => fileName);

    let watchHost: ts.WatchOfFilesAndCompilerOptionsHost;
    let watch: ts.WatchOfFilesAndCompilerOptions;
    let _program: ts.Program;
    let builderState: ts.BuilderState;

    function createSystem(): ts.System {
        return {
            args: [],
            newLine: compiler.sys.newLine,
            useCaseSensitiveFileNames: compiler.sys.useCaseSensitiveFileNames,

            getCurrentDirectory: () => context,
            getExecutingFilePath: () => compiler.sys.getExecutingFilePath(),

            readFile,
            fileExists: (...args) => compiler.sys.fileExists.apply(compiler.sys, args),
            directoryExists: (...args) => compiler.sys.directoryExists.apply(compiler.sys, args),
            getDirectories: (...args) => compiler.sys.getDirectories.apply(compiler.sys, args),
            readDirectory: (...args) => compiler.sys.readDirectory.apply(compiler.sys, args),

            resolvePath: (...args) => compiler.sys.resolvePath.apply(compiler.sys, args),

            write: noop,

            // All write operations are noop and we will deal with them separately
            createDirectory: notImplemented,
            writeFile: notImplemented,

            createHash: (...args) => compiler.sys.createHash.apply(compiler.sys, args),

            exit: noop,

            watchFile,
            watchDirectory
        };

        function readFile(fileName: string) {
            ensureFile(fileName);
            const file = files.get(fileName);
            if (file) {
                return file.text;
            }
        }
    }

    function createWatchHost(): ts.WatchOfFilesAndCompilerOptionsHost {
        system = createSystem();
        const builderOptions: ts.BuilderOptions = {
            computeHash: (...args) => compiler.sys.createHash.apply(compiler.sys, args),
            getCanonicalFileName
        };

        return {
            rootFiles: getRootFiles(),
            options: compilerOptions,
            system,
            beforeProgramCreate: noop,
            afterProgramCreate: (host, newProgram) => {
                _program = newProgram;
                builderState = compiler.createBuilderState(newProgram, builderOptions, builderState);
            }
        };
    }

    function createWatch(): ts.WatchOfFilesAndCompilerOptions {
        watchHost = createWatchHost();
        return compiler.createWatch(watchHost);
    }

    function getProgram(): ts.Program {
        if (rootFilesChanged) {
            rootFilesChanged = false;
            watch.updateRootFileNames(getRootFiles());
        }
        watch.synchronizeProgram();
        return _program;
    }

    function getRootFiles() {
        const names = files.map(file => file.fileName)
            .filter(fileName => filesRegex.test(fileName));
        return names;
    }

    function invokeWatcherCallbacks(callbacks: ts.FileWatcherCallback[] | undefined, fileName: string, eventKind: ts.FileWatcherEventKind): void;
    function invokeWatcherCallbacks(callbacks: ts.DirectoryWatcherCallback[] | undefined, fileName: string): void;
    function invokeWatcherCallbacks(callbacks: ts.FileWatcherCallback[] | ts.DirectoryWatcherCallback[] | undefined, fileName: string, eventKind?: ts.FileWatcherEventKind) {
        if (callbacks) {
            // The array copy is made to ensure that even if one of the callback removes the callbacks,
            // we dont miss any callbacks following it
            const cbs = callbacks.slice();
            for (const cb of cbs) {
                cb(fileName, eventKind as ts.FileWatcherEventKind);
            }
        }
    }

    function invokeFileWatcher(fileName: string, eventKind: ts.FileWatcherEventKind) {
        fileName = getCanonicalFileName(fileName);
        invokeWatcherCallbacks(watchedFiles.get(fileName), fileName, eventKind);
    }

    function invokeDirectoryWatcher(directory: string, fileAddedOrRemoved: string) {
        directory = getCanonicalFileName(directory);
        invokeWatcherCallbacks(watchedDirectories.get(directory), fileAddedOrRemoved);
        invokeRecursiveDirectoryWatcher(directory, fileAddedOrRemoved);
    }

    function invokeRecursiveDirectoryWatcher(directory: string, fileAddedOrRemoved: string) {
        invokeWatcherCallbacks(watchedDirectoriesRecursive.get(directory), fileAddedOrRemoved);
        const basePath = path.dirname(directory);
        if (directory !== basePath) {
            invokeRecursiveDirectoryWatcher(basePath, fileAddedOrRemoved);
        }
    }

    function createWatcher<T>(file: string, callbacks: WatchCallbacks<T>, callback: T): ts.FileWatcher {
        file = getCanonicalFileName(file);
        const existing = callbacks.get(file);
        if (existing) {
            existing.push(callback);
        }
        else {
            callbacks.set(file, [callback]);
        }
        return {
            close: () => {
                const existing = callbacks.get(file);
                if (existing) {
                    unorderedRemoveItem(existing, callback);
                }
            }
        };
    }

    function watchFile(fileName: string, callback: ts.FileWatcherCallback, _pollingInterval?: number) {
        return createWatcher(fileName, watchedFiles, callback);
    }

    function watchDirectory(fileName: string, callback: ts.DirectoryWatcherCallback, recursive?: boolean) {
        return createWatcher(fileName, recursive ? watchedDirectoriesRecursive : watchedDirectories, callback);
    }

    function onFileCreated(fileName: string) {
        rootFilesChanged = true;
        invokeFileWatcher(fileName, compiler.FileWatcherEventKind.Created);
        invokeDirectoryWatcher(path.dirname(fileName), fileName);
    }

    function onFileRemoved(fileName: string) {
        rootFilesChanged = true;
        invokeFileWatcher(fileName, compiler.FileWatcherEventKind.Deleted);
        invokeDirectoryWatcher(path.dirname(fileName), fileName);
    }

    function onFileChanged(fileName: string) {
        invokeFileWatcher(fileName, compiler.FileWatcherEventKind.Changed);
    }

    function ensureFile(fileName: string) {
        const file = files.get(fileName);
        if (!file) {
            const text = compiler.sys.readFile(fileName);
            if (text) {
                files.set(fileName, {
                    fileName: fileName,
                    text,
                });
                onFileCreated(fileName);
            }
        } else {
            if (file.fileName !== fileName) {
                if (caseInsensitive) {
                    file.fileName = fileName; // use most recent name for case-sensitive file systems
                    onFileChanged(fileName);
                } else {
                    removeFile(file.fileName);

                    const text = compiler.sys.readFile(fileName);
                    files.set(fileName, {
                        fileName,
                        text,
                    });
                    onFileCreated(fileName);
                }
            }
        }
    }

    const TS_AND_JS_FILES = /\.tsx?$|\.jsx?$/i;
    const TS_FILES = /\.tsx?$/i;

    function processInit({ seq, payload }: Init.Request) {
        compiler = require(payload.compilerInfo.compilerPath);
        loaderConfig = payload.loaderConfig;
        compilerConfig = payload.compilerConfig;
        compilerOptions = compilerConfig.options;
        context = payload.context;
        filesRegex = compilerOptions.allowJs ? TS_AND_JS_FILES : TS_FILES;

        instanceName = loaderConfig.instance || 'at-loader';

        compilerConfig.fileNames.forEach(fileName => ensureFile(fileName));
        watch = createWatch();
        
        if (loaderConfig.debug) {
            console.log(`[${instanceName}] @DEBUG Initial files`, Object.keys(files));
        }

        if (loaderConfig.ignoreDiagnostics) {
            loaderConfig.ignoreDiagnostics.forEach(diag => {
                ignoreDiagnostics[diag] = true;
            });
        }

        replyOk(seq, null);
    }

    function updateFile(fileName: string, text: string, ifExist = false) {
        const file = files.get(fileName);
        if (file) {
            let updated = false;
            if (file.fileName !== fileName) {
                if (caseInsensitive) {
                    file.fileName = fileName; // use most recent name for case-sensitive file systems
                } else {
                    removeFile(file.fileName);

                    files.set(fileName, {
                        fileName,
                        text,
                    });
                    onFileCreated(fileName);
                }
            }
            if (file.text !== text) { updated = updated || true; }
            if (!updated) {
                return;
            }
            file.text = text;
            onFileChanged(fileName);
        } else if (!ifExist) {
            files.set(fileName, {
                fileName,
                text
            });
            onFileCreated(fileName);
        }
    }

    function removeFile(fileName: string) {
        if (files.has(fileName)) {
            files.delete(fileName);
            onFileRemoved(fileName);
        }
    }

    function getEmitOutput(fileName: string) {
        const program = getProgram();
        const outputFiles: ts.OutputFile[] = [];
        const writeFile = (fileName: string, text: string, writeByteOrderMark: boolean) =>
            outputFiles.push({ name: fileName, writeByteOrderMark, text });
        const sourceFile = program.getSourceFile(fileName);
        program.emit(sourceFile, writeFile, /*cancellationToken*/ undefined, /*emitOnlyDtsFiles*/ false, loaderConfig.getCustomTransformers && loaderConfig.getCustomTransformers());
        return outputFiles;
    }

    function emit(fileName: string) {
        if (loaderConfig.useTranspileModule || loaderConfig.transpileOnly) {
            return fastEmit(fileName);
        } else {
            const outputFiles = getEmitOutput(fileName);
            if (outputFiles.length > 0) {
                return findResultFor(fileName, outputFiles);
            } else {
                // Use fast emit in case of errors
                return fastEmit(fileName);
            }
        }
    }

    function fastEmit(fileName: string) {
        const trans = compiler.transpileModule(files.get(fileName).text, {
            compilerOptions: compilerOptions,
            fileName,
            reportDiagnostics: false
        });

        return {
            text: trans.outputText,
            sourceMap: trans.sourceMapText
        };
    }

    function processUpdate({ seq, payload }: UpdateFile.Request) {
        updateFile(payload.fileName, payload.text, payload.ifExist);
        replyOk(seq, null);
    }

    function processRemove({ seq, payload }: RemoveFile.Request) {
        removeFile(payload.fileName);
        replyOk(seq, null);
    }

    function processEmit({ seq, payload }: EmitFile.Request) {
        updateFile(payload.fileName, payload.text);
        const emitResult = emit(payload.fileName);
        const program = getProgram();
        const sourceFile = program.getSourceFile(payload.fileName);
        const deps = builderState.getAllDependencies(program, sourceFile);

        replyOk(seq, { emitResult, deps });
    }

    function processFiles({ seq }: Files.Request) {
        replyOk(seq, {
            files: getProgram().getSourceFiles().map(f => f.fileName)
        });
    }

    function processDiagnostics({ seq }: Diagnostics.Request) {
        let silent = !!loaderConfig.silent;

        if (!silent) {
            console.log(colors.cyan(`\n[${instanceName}] Checking started in a separate process...`));
        }

        const program = getProgram();
        const sourceFiles = program.getSourceFiles();

        const allDiagnostics = program
            .getOptionsDiagnostics()
            .concat(program.getGlobalDiagnostics());

        const filters: Filter[] = [];

        if (compilerConfig.options.skipLibCheck) {
            filters.push(file => {
                return !file.isDeclarationFile;
            });
        }

        if (loaderConfig.reportFiles) {
            filters.push(file => {
                const fileName = path.relative(context, file.fileName);
                return micromatch(fileName, loaderConfig.reportFiles).length > 0;
            });
        }

        sourceFiles.forEach(file => {
            if (filters.length && filters.some(f => !f(file))) {
                // Skip the file
                return;
            }

            allDiagnostics.push(...program.getSyntacticDiagnostics(file));
            allDiagnostics.push(...program.getSemanticDiagnostics(file));
        });

        if (loaderConfig.debug) {
            console.log(`[${instanceName}] @DEBUG Typechecked files`, program.getSourceFiles());
        }

        const processedDiagnostics = allDiagnostics
            .filter(diag => !ignoreDiagnostics[diag.code])
            .map(diagnostic => {
                const message = compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
                let fileName = diagnostic.file && path.relative(context, diagnostic.file.fileName);

                if (fileName && fileName[0] !== '.') {
                    fileName = './' + toUnix(fileName);
                }

                let pretty = '';
                let line = 0;
                let character = 0;
                let code = diagnostic.code;

                if (diagnostic.file) {
                    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                    line = pos.line;
                    character = pos.character;
                    pretty = (`[${instanceName}] ${colors.red(fileName)}:${line + 1}:${character + 1} \n    TS${code}: ${colors.red(message)}`);
                } else {
                    pretty = (colors.red(`[${instanceName}] TS${code}: ${message}`));
                }

                return {
                    category: diagnostic.category,
                    code: diagnostic.code,
                    fileName,
                    start: diagnostic.start,
                    message,
                    pretty,
                    line,
                    character
                };
            });

        replyOk(seq, processedDiagnostics);
    }

    function replyOk(seq: number, payload: any) {
        send({
            seq,
            success: true,
            payload
        } as Res);
    }

    function replyErr(seq: number, payload: any) {
        send({
            seq,
            success: false,
            payload
        } as Res);
    }

    receive(function (req: Req) {
        try {
            switch (req.type) {
                case MessageType.Init:
                    processInit(req);
                    break;
                case MessageType.RemoveFile:
                    processRemove(req);
                    break;
                case MessageType.UpdateFile:
                    processUpdate(req);
                    break;
                case MessageType.EmitFile:
                    processEmit(req);
                    break;
                case MessageType.Diagnostics:
                    processDiagnostics(req);
                    break;
                case MessageType.Files:
                    processFiles(req);
                    break;

            }
        } catch (e) {
            console.error(`[${instanceName}]: Child process failed to process the request: `, e);
            replyErr(req.seq, null);
        }
    });
}
