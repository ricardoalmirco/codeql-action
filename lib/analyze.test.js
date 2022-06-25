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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ava_1 = __importDefault(require("ava"));
const yaml = __importStar(require("js-yaml"));
const sinon = __importStar(require("sinon"));
const analyze_1 = require("./analyze");
const codeql_1 = require("./codeql");
const count = __importStar(require("./count-loc"));
const languages_1 = require("./languages");
const logging_1 = require("./logging");
const testing_utils_1 = require("./testing-utils");
const util = __importStar(require("./util"));
(0, testing_utils_1.setupTests)(ava_1.default);
// Checks that the duration fields are populated for the correct language
// and correct case of builtin or custom. Also checks the correct search
// paths are set in the database analyze invocation.
(0, ava_1.default)("status report fields and search path setting", async (t) => {
    const mockLinesOfCode = Object.values(languages_1.Language).reduce((obj, lang, i) => {
        // use a different line count for each language
        obj[lang] = i + 1;
        return obj;
    }, {});
    sinon.stub(count, "countLoc").resolves(mockLinesOfCode);
    let searchPathsUsed = [];
    return await util.withTmpDir(async (tmpDir) => {
        (0, testing_utils_1.setupActionsVars)(tmpDir, tmpDir);
        const memoryFlag = "";
        const addSnippetsFlag = "";
        const threadsFlag = "";
        const packs = {
            [languages_1.Language.cpp]: ["a/b@1.0.0"],
            [languages_1.Language.java]: ["c/d@2.0.0"],
        };
        for (const language of Object.values(languages_1.Language)) {
            (0, codeql_1.setCodeQL)({
                packDownload: async () => ({ packs: [] }),
                databaseRunQueries: async (_db, searchPath) => {
                    searchPathsUsed.push(searchPath);
                },
                databaseInterpretResults: async (_db, _queriesRun, sarifFile) => {
                    fs.writeFileSync(sarifFile, JSON.stringify({
                        runs: [
                            // references a rule with the lines-of-code tag, so baseline should be injected
                            {
                                tool: {
                                    extensions: [
                                        {
                                            rules: [
                                                {
                                                    properties: {
                                                        tags: ["lines-of-code"],
                                                    },
                                                },
                                            ],
                                        },
                                    ],
                                },
                                properties: {
                                    metricResults: [
                                        {
                                            rule: {
                                                index: 0,
                                                toolComponent: {
                                                    index: 0,
                                                },
                                            },
                                            value: 123,
                                        },
                                    ],
                                },
                            },
                            {},
                        ],
                    }));
                    return "";
                },
            });
            searchPathsUsed = [];
            const config = {
                languages: [language],
                queries: {},
                pathsIgnore: [],
                paths: [],
                originalUserInput: {},
                tempDir: tmpDir,
                toolCacheDir: tmpDir,
                codeQLCmd: "",
                gitHubVersion: {
                    type: util.GitHubVariant.DOTCOM,
                },
                dbLocation: path.resolve(tmpDir, "codeql_databases"),
                packs,
                debugMode: false,
                debugArtifactName: util.DEFAULT_DEBUG_ARTIFACT_NAME,
                debugDatabaseName: util.DEFAULT_DEBUG_DATABASE_NAME,
                augmentationProperties: {
                    injectedMlQueries: false,
                    packsInputCombines: false,
                    queriesInputCombines: false,
                },
            };
            fs.mkdirSync(util.getCodeQLDatabasePath(config, language), {
                recursive: true,
            });
            config.queries[language] = {
                builtin: ["foo.ql"],
                custom: [],
            };
            const builtinStatusReport = await (0, analyze_1.runQueries)(tmpDir, memoryFlag, addSnippetsFlag, threadsFlag, undefined, config, (0, logging_1.getRunnerLogger)(true));
            const hasPacks = language in packs;
            const statusReportKeys = Object.keys(builtinStatusReport).sort();
            if (hasPacks) {
                t.deepEqual(statusReportKeys.length, 3, statusReportKeys.toString());
                t.deepEqual(statusReportKeys[0], `analyze_builtin_queries_${language}_duration_ms`);
                t.deepEqual(statusReportKeys[1], `analyze_custom_queries_${language}_duration_ms`);
                t.deepEqual(statusReportKeys[2], `interpret_results_${language}_duration_ms`);
            }
            else {
                t.deepEqual(statusReportKeys[0], `analyze_builtin_queries_${language}_duration_ms`);
                t.deepEqual(statusReportKeys[1], `interpret_results_${language}_duration_ms`);
            }
            config.queries[language] = {
                builtin: [],
                custom: [
                    {
                        queries: ["foo.ql"],
                        searchPath: "/1",
                    },
                    {
                        queries: ["bar.ql"],
                        searchPath: "/2",
                    },
                ],
            };
            const customStatusReport = await (0, analyze_1.runQueries)(tmpDir, memoryFlag, addSnippetsFlag, threadsFlag, undefined, config, (0, logging_1.getRunnerLogger)(true));
            t.deepEqual(Object.keys(customStatusReport).length, 2);
            t.true(`analyze_custom_queries_${language}_duration_ms` in customStatusReport);
            const expectedSearchPathsUsed = hasPacks
                ? [undefined, undefined, "/1", "/2", undefined]
                : [undefined, "/1", "/2"];
            t.deepEqual(searchPathsUsed, expectedSearchPathsUsed);
            t.true(`interpret_results_${language}_duration_ms` in customStatusReport);
        }
        verifyLineCounts(tmpDir);
        verifyQuerySuites(tmpDir);
    });
    function verifyLineCounts(tmpDir) {
        // eslint-disable-next-line github/array-foreach
        Object.keys(languages_1.Language).forEach((lang, i) => {
            verifyLineCountForFile(path.join(tmpDir, `${lang}.sarif`), i + 1);
        });
    }
    function verifyLineCountForFile(filePath, lineCount) {
        const sarif = JSON.parse(fs.readFileSync(filePath, "utf8"));
        t.deepEqual(sarif.runs[0].properties.metricResults, [
            {
                rule: {
                    index: 0,
                    toolComponent: {
                        index: 0,
                    },
                },
                value: 123,
                baseline: lineCount,
            },
        ]);
        // when the rule doesn't exist, it should not be added
        t.deepEqual(sarif.runs[1].properties.metricResults, []);
    }
    function verifyQuerySuites(tmpDir) {
        const qlsContent = [
            {
                query: "foo.ql",
            },
        ];
        const qlsContent2 = [
            {
                query: "bar.ql",
            },
        ];
        for (const lang of Object.values(languages_1.Language)) {
            t.deepEqual(readContents(`${lang}-queries-builtin.qls`), qlsContent);
            t.deepEqual(readContents(`${lang}-queries-custom-0.qls`), qlsContent);
            t.deepEqual(readContents(`${lang}-queries-custom-1.qls`), qlsContent2);
        }
        function readContents(name) {
            const x = fs.readFileSync(path.join(tmpDir, "codeql_databases", name), "utf8");
            console.log(x);
            return yaml.load(fs.readFileSync(path.join(tmpDir, "codeql_databases", name), "utf8"));
        }
    }
});
//# sourceMappingURL=analyze.test.js.map