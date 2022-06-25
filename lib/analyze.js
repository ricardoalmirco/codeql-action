"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCleanup = exports.runFinalize = exports.runQueries = exports.CodeQLAnalysisError = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const toolrunner = __importStar(require("@actions/exec/lib/toolrunner"));
const del_1 = __importDefault(require("del"));
const yaml = __importStar(require("js-yaml"));
const analysisPaths = __importStar(require("./analysis-paths"));
const codeql_1 = require("./codeql");
const count_loc_1 = require("./count-loc");
const languages_1 = require("./languages");
const sharedEnv = __importStar(require("./shared-environment"));
const tracer_config_1 = require("./tracer-config");
const util = __importStar(require("./util"));
class CodeQLAnalysisError extends Error {
    constructor(queriesStatusReport, message) {
        super(message);
        this.name = "CodeQLAnalysisError";
        this.queriesStatusReport = queriesStatusReport;
    }
}
exports.CodeQLAnalysisError = CodeQLAnalysisError;
async function setupPythonExtractor(logger) {
    const codeqlPython = process.env["CODEQL_PYTHON"];
    if (codeqlPython === undefined || codeqlPython.length === 0) {
        // If CODEQL_PYTHON is not set, no dependencies were installed, so we don't need to do anything
        return;
    }
    let output = "";
    const options = {
        listeners: {
            stdout: (data) => {
                output += data.toString();
            },
        },
    };
    await new toolrunner.ToolRunner(codeqlPython, [
        "-c",
        "import os; import pip; print(os.path.dirname(os.path.dirname(pip.__file__)))",
    ], options).exec();
    logger.info(`Setting LGTM_INDEX_IMPORT_PATH=${output}`);
    process.env["LGTM_INDEX_IMPORT_PATH"] = output;
    output = "";
    await new toolrunner.ToolRunner(codeqlPython, ["-c", "import sys; print(sys.version_info[0])"], options).exec();
    logger.info(`Setting LGTM_PYTHON_SETUP_VERSION=${output}`);
    process.env["LGTM_PYTHON_SETUP_VERSION"] = output;
}
async function createdDBForScannedLanguages(config, logger) {
    // Insert the LGTM_INDEX_X env vars at this point so they are set when
    // we extract any scanned languages.
    analysisPaths.includeAndExcludeAnalysisPaths(config);
    const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
    for (const language of config.languages) {
        if ((0, languages_1.isScannedLanguage)(language) &&
            !dbIsFinalized(config, language, logger)) {
            logger.startGroup(`Extracting ${language}`);
            if (language === languages_1.Language.python) {
                await setupPythonExtractor(logger);
            }
            await codeql.extractScannedLanguage(util.getCodeQLDatabasePath(config, language), language);
            logger.endGroup();
        }
    }
}
function dbIsFinalized(config, language, logger) {
    const dbPath = util.getCodeQLDatabasePath(config, language);
    try {
        const dbInfo = yaml.load(fs.readFileSync(path.resolve(dbPath, "codeql-database.yml"), "utf8"));
        return !("inProgress" in dbInfo);
    }
    catch (e) {
        logger.warning(`Could not check whether database for ${language} was finalized. Assuming it is not.`);
        return false;
    }
}
async function finalizeDatabaseCreation(config, threadsFlag, memoryFlag, logger) {
    await createdDBForScannedLanguages(config, logger);
    const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
    for (const language of config.languages) {
        if (dbIsFinalized(config, language, logger)) {
            logger.info(`There is already a finalized database for ${language} at the location where the CodeQL Action places databases, so we did not create one.`);
        }
        else {
            logger.startGroup(`Finalizing ${language}`);
            await codeql.finalizeDatabase(util.getCodeQLDatabasePath(config, language), threadsFlag, memoryFlag);
            logger.endGroup();
        }
    }
}
// Runs queries and creates sarif files in the given folder
async function runQueries(sarifFolder, memoryFlag, addSnippetsFlag, threadsFlag, automationDetailsId, config, logger) {
    const statusReport = {};
    let locPromise = Promise.resolve({});
    const cliCanCountBaseline = await cliCanCountLoC();
    const debugMode = process.env["INTERNAL_CODEQL_ACTION_DEBUG_LOC"] ||
        process.env["ACTIONS_RUNNER_DEBUG"] ||
        process.env["ACTIONS_STEP_DEBUG"];
    if (!cliCanCountBaseline || debugMode) {
        // count the number of lines in the background
        locPromise = (0, count_loc_1.countLoc)(path.resolve(), 
        // config.paths specifies external directories. the current
        // directory is included in the analysis by default. Replicate
        // that here.
        config.paths, config.pathsIgnore, config.languages, logger);
    }
    for (const language of config.languages) {
        const queries = config.queries[language];
        const packsWithVersion = config.packs[language] || [];
        const hasBuiltinQueries = (queries === null || queries === void 0 ? void 0 : queries.builtin.length) > 0;
        const hasCustomQueries = (queries === null || queries === void 0 ? void 0 : queries.custom.length) > 0;
        const hasPackWithCustomQueries = packsWithVersion.length > 0;
        if (!hasBuiltinQueries && !hasCustomQueries && !hasPackWithCustomQueries) {
            throw new Error(`Unable to analyse ${language} as no queries were selected for this language`);
        }
        const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
        try {
            if (hasPackWithCustomQueries &&
                !(await util.useCodeScanningConfigInCli(codeql))) {
                logger.info("Performing analysis with custom CodeQL Packs.");
                logger.startGroup(`Downloading custom packs for ${language}`);
                const results = await codeql.packDownload(packsWithVersion);
                logger.info(`Downloaded packs: ${results.packs
                    .map((r) => `${r.name}@${r.version || "latest"}`)
                    .join(", ")}`);
                logger.endGroup();
            }
            logger.startGroup(`Running queries for ${language}`);
            const querySuitePaths = [];
            if (queries["builtin"].length > 0) {
                const startTimeBuiltIn = new Date().getTime();
                querySuitePaths.push(await runQueryGroup(language, "builtin", createQuerySuiteContents(queries["builtin"]), undefined));
                statusReport[`analyze_builtin_queries_${language}_duration_ms`] =
                    new Date().getTime() - startTimeBuiltIn;
            }
            const startTimeCustom = new Date().getTime();
            let ranCustom = false;
            for (let i = 0; i < queries["custom"].length; ++i) {
                if (queries["custom"][i].queries.length > 0) {
                    querySuitePaths.push(await runQueryGroup(language, `custom-${i}`, createQuerySuiteContents(queries["custom"][i].queries), queries["custom"][i].searchPath));
                    ranCustom = true;
                }
            }
            if (packsWithVersion.length > 0) {
                querySuitePaths.push(...(await runQueryPacks(language, "packs", packsWithVersion, undefined)));
                ranCustom = true;
            }
            if (ranCustom) {
                statusReport[`analyze_custom_queries_${language}_duration_ms`] =
                    new Date().getTime() - startTimeCustom;
            }
            logger.endGroup();
            logger.startGroup(`Interpreting results for ${language}`);
            const startTimeInterpretResults = new Date().getTime();
            const sarifFile = path.join(sarifFolder, `${language}.sarif`);
            const analysisSummary = await runInterpretResults(language, querySuitePaths, sarifFile);
            if (!cliCanCountBaseline)
                await injectLinesOfCode(sarifFile, language, locPromise);
            statusReport[`interpret_results_${language}_duration_ms`] =
                new Date().getTime() - startTimeInterpretResults;
            logger.endGroup();
            logger.info(analysisSummary);
            if (!cliCanCountBaseline || debugMode)
                printLinesOfCodeSummary(logger, language, await locPromise);
            if (cliCanCountBaseline)
                logger.info(await runPrintLinesOfCode(language));
        }
        catch (e) {
            logger.info(String(e));
            if (e instanceof Error) {
                logger.info(e.stack);
            }
            statusReport.analyze_failure_language = language;
            throw new CodeQLAnalysisError(statusReport, `Error running analysis for ${language}: ${e}`);
        }
    }
    return statusReport;
    async function runInterpretResults(language, queries, sarifFile) {
        const databasePath = util.getCodeQLDatabasePath(config, language);
        const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
        return await codeql.databaseInterpretResults(databasePath, queries, sarifFile, addSnippetsFlag, threadsFlag, automationDetailsId);
    }
    async function cliCanCountLoC() {
        return await util.codeQlVersionAbove(await (0, codeql_1.getCodeQL)(config.codeQLCmd), codeql_1.CODEQL_VERSION_COUNTS_LINES);
    }
    async function runPrintLinesOfCode(language) {
        const databasePath = util.getCodeQLDatabasePath(config, language);
        const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
        return await codeql.databasePrintBaseline(databasePath);
    }
    async function runQueryGroup(language, type, querySuiteContents, searchPath) {
        const databasePath = util.getCodeQLDatabasePath(config, language);
        // Pass the queries to codeql using a file instead of using the command
        // line to avoid command line length restrictions, particularly on windows.
        const querySuitePath = `${databasePath}-queries-${type}.qls`;
        fs.writeFileSync(querySuitePath, querySuiteContents);
        logger.debug(`Query suite file for ${language}-${type}...\n${querySuiteContents}`);
        const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
        await codeql.databaseRunQueries(databasePath, searchPath, querySuitePath, memoryFlag, threadsFlag);
        logger.debug(`BQRS results produced for ${language} (queries: ${type})"`);
        return querySuitePath;
    }
    async function runQueryPacks(language, type, packs, searchPath) {
        const databasePath = util.getCodeQLDatabasePath(config, language);
        // Run the queries individually instead of all at once to avoid command
        // line length restrictions, particularly on windows.
        for (const pack of packs) {
            logger.debug(`Running query pack for ${language}-${type}: ${pack}`);
            const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
            await codeql.databaseRunQueries(databasePath, searchPath, pack, memoryFlag, threadsFlag);
            logger.debug(`BQRS results produced for ${language} (queries: ${type})"`);
        }
        return packs;
    }
}
exports.runQueries = runQueries;
function createQuerySuiteContents(queries) {
    return queries.map((q) => `- query: ${q}`).join("\n");
}
async function runFinalize(outputDir, threadsFlag, memoryFlag, config, logger) {
    const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
    if (await util.codeQlVersionAbove(codeql, codeql_1.CODEQL_VERSION_NEW_TRACING)) {
        // Delete variables as specified by the end-tracing script
        await (0, tracer_config_1.endTracingForCluster)(config);
    }
    else {
        // Delete the tracer config env var to avoid tracing ourselves
        delete process.env[sharedEnv.ODASA_TRACER_CONFIGURATION];
    }
    try {
        await (0, del_1.default)(outputDir, { force: true });
    }
    catch (error) {
        if ((error === null || error === void 0 ? void 0 : error.code) !== "ENOENT") {
            throw error;
        }
    }
    await fs.promises.mkdir(outputDir, { recursive: true });
    await finalizeDatabaseCreation(config, threadsFlag, memoryFlag, logger);
}
exports.runFinalize = runFinalize;
async function runCleanup(config, cleanupLevel, logger) {
    logger.startGroup("Cleaning up databases");
    for (const language of config.languages) {
        const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
        const databasePath = util.getCodeQLDatabasePath(config, language);
        await codeql.databaseCleanup(databasePath, cleanupLevel);
    }
    logger.endGroup();
}
exports.runCleanup = runCleanup;
async function injectLinesOfCode(sarifFile, language, locPromise) {
    var _a;
    const lineCounts = await locPromise;
    if (language in lineCounts) {
        const sarif = JSON.parse(fs.readFileSync(sarifFile, "utf8"));
        if (Array.isArray(sarif.runs)) {
            for (const run of sarif.runs) {
                run.properties = run.properties || {};
                run.properties.metricResults = run.properties.metricResults || [];
                for (const metric of run.properties.metricResults) {
                    // Baseline is inserted when matching rule has tag lines-of-code
                    if (metric.rule && metric.rule.toolComponent) {
                        const matchingRule = run.tool.extensions[metric.rule.toolComponent.index].rules[metric.rule.index];
                        if ((_a = matchingRule.properties.tags) === null || _a === void 0 ? void 0 : _a.includes("lines-of-code")) {
                            metric.baseline = lineCounts[language];
                        }
                    }
                }
            }
        }
        fs.writeFileSync(sarifFile, JSON.stringify(sarif));
    }
}
function printLinesOfCodeSummary(logger, language, lineCounts) {
    if (language in lineCounts) {
        logger.info(`Counted a baseline of ${lineCounts[language]} lines of code for ${language}.`);
    }
}
//# sourceMappingURL=analyze.js.map