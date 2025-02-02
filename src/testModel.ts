/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { WorkspaceChange } from './workspaceObserver';
import * as vscodeTypes from './vscodeTypes';
import { escapeRegex, pathSeparator, resolveSourceMap } from './utils';
import { ConfigListFilesReport, ProjectConfigWithFiles } from './listTests';
import * as reporterTypes from './upstream/reporter';
import { TeleSuite } from './upstream/teleReceiver';
import type { SettingsModel, WorkspaceSettings } from './settingsModel';
import path from 'path';
import { DisposableBase } from './disposableBase';
import { MultiMap } from './multimap';
import { TestServerInterface } from './upstream/testServerInterface';
import { ReporterServer } from './reporterServer';
import { debugSessionName } from './debugSessionName';
import { PlaywrightTestServer } from './playwrightTestServer';
import type { RunHooks, TestConfig } from './playwrightTestTypes';
import { PlaywrightTestCLI } from './playwrightTestCLI';

export type TestEntry = reporterTypes.TestCase | reporterTypes.Suite;

export type TestProject = {
  model: TestModel;
  name: string;
  suite: reporterTypes.Suite;
  project: reporterTypes.FullProject;
  isEnabled: boolean;
};

export type TestModelOptions = {
  settingsModel: SettingsModel;
  runHooks: RunHooks;
  isUnderTest: boolean;
  playwrightTestLog: string[];
  envProvider: () => NodeJS.ProcessEnv;
};

type AllRunOptions = Parameters<TestServerInterface['runTests']>[0];
export type PlaywrightTestRunOptions = Pick<AllRunOptions, 'headed' | 'workers' | 'trace' | 'projects' | 'grep' | 'reuseContext' | 'connectWsEndpoint'>;

export class TestModel {
  private _vscode: vscodeTypes.VSCode;
  readonly config: TestConfig;
  private _projects = new Map<string, TestProject>();
  private _didUpdate: vscodeTypes.EventEmitter<void>;
  readonly onUpdated: vscodeTypes.Event<void>;
  private _playwrightTest: PlaywrightTestCLI | PlaywrightTestServer;
  private _fileToSources: Map<string, string[]> = new Map();
  private _sourceToFile: Map<string, string> = new Map();
  private _envProvider: () => NodeJS.ProcessEnv;
  isEnabled = false;
  readonly tag: vscodeTypes.TestTag;
  private _errorByFile = new MultiMap<string, reporterTypes.TestError>();
  private _options: TestModelOptions;
  private _filesWithListedTests = new Set<string>();
  private _filesPendingListTests: {
    files: Set<string>,
    timer: NodeJS.Timeout,
    promise: Promise<void>,
    finishedCallback: () => void
  } | undefined;

  constructor(vscode: vscodeTypes.VSCode, workspaceFolder: string, configFile: string, playwrightInfo: { cli: string, version: number }, options: TestModelOptions) {
    this._vscode = vscode;
    this._options = options;
    this.config = { ...playwrightInfo, workspaceFolder, configFile };
    this._playwrightTest = options.settingsModel.useTestServer.get() ? new PlaywrightTestServer(vscode, this.config, options) : new PlaywrightTestCLI(vscode, this.config, options);
    this._didUpdate = new vscode.EventEmitter();
    this.onUpdated = this._didUpdate.event;
    this._envProvider = options.envProvider;
    this.tag = new this._vscode.TestTag(this.config.configFile);
  }

  reset() {
    clearTimeout(this._filesPendingListTests?.timer);
    this._filesPendingListTests?.finishedCallback();
    delete this._filesPendingListTests;
    this._projects.clear();
    this._fileToSources.clear();
    this._sourceToFile.clear();
    this._errorByFile.clear();
    this._playwrightTest.reset();
  }

  projects(): TestProject[] {
    return [...this._projects.values()];
  }

  errors(): MultiMap<string, reporterTypes.TestError> {
    return this._errorByFile;
  }

  projectMap(): Map<string, TestProject> {
    return this._projects;
  }

  testDirs(): string[] {
    return [...new Set([...this._projects.values()].map(p => p.project.testDir))];
  }

  enabledProjects(): TestProject[] {
    return [...this._projects.values()].filter(p => p.isEnabled);
  }

  enabledFiles(): Set<string> {
    const result = new Set<string>();
    for (const project of this.enabledProjects()) {
      const files = projectFiles(project);
      for (const file of files.keys())
        result.add(file);
    }
    return result;
  }

  async _listFiles() {
    this._filesWithListedTests.clear();
    let report: ConfigListFilesReport;
    try {
      report = await this._playwrightTest.listFiles();
      for (const project of report.projects)
        project.files = project.files.map(f => this._vscode.Uri.file(f).fsPath);
      if (report.error?.location)
        report.error.location.file = this._vscode.Uri.file(report.error.location.file).fsPath;
    } catch (error: any) {
      report = {
        error: {
          location: { file: this.config.configFile, line: 0, column: 0 },
          message: error.message,
        },
        projects: [],
      };
    }

    if (report.error?.location) {
      this._errorByFile.set(report.error?.location.file, report.error);
      this._didUpdate.fire();
      return;
    }

    // Resolve files to sources when using source maps.
    for (const project of report.projects) {
      const files: string[] = [];
      for (const file of project.files)
        files.push(...await resolveSourceMap(file, this._fileToSources, this._sourceToFile));
      project.files = files;
      this.config.testIdAttributeName = project.use?.testIdAttribute;
    }

    const projectsToKeep = new Set<string>();
    for (const projectReport of report.projects) {
      projectsToKeep.add(projectReport.name);
      let project = this._projects.get(projectReport.name);
      if (!project)
        project = this._createProject(projectReport);
      this._updateProjectFiles(project, projectReport);
    }

    for (const projectName of this._projects.keys()) {
      if (!projectsToKeep.has(projectName))
        this._projects.delete(projectName);
    }

    this._didUpdate.fire();
  }

  private _createProject(projectReport: ProjectConfigWithFiles): TestProject {
    const projectSuite = new TeleSuite(projectReport.name, 'project');
    projectSuite._project = {
      dependencies: [],
      grep: '.*',
      grepInvert: null,
      metadata: {},
      name: projectReport.name,
      outputDir: '',
      repeatEach: 0,
      retries: 0,
      snapshotDir: '',
      testDir: projectReport.testDir,
      testIgnore: [],
      testMatch: '.*',
      timeout: 0,
      use: projectReport.use,
    };
    const project: TestProject = {
      model: this,
      name: projectReport.name,
      suite: projectSuite,
      project: projectSuite._project,
      isEnabled: false,
    };
    this._projects.set(project.name, project);
    return project;
  }

  private _updateProjectFiles(project: TestProject, projectReport: ProjectConfigWithFiles) {
    const filesToKeep = new Set<string>();
    const files = projectFiles(project);
    for (const file of projectReport.files) {
      filesToKeep.add(file);
      const testFile = files.get(file);
      if (!testFile) {
        const testFile = new TeleSuite(file, 'file');
        testFile.location = { file, line: 0, column: 0 };
        (testFile as any)[listFilesFlag] = true;
        files.set(file, testFile);
      }
    }

    for (const file of files.keys()) {
      if (!filesToKeep.has(file))
        files.delete(file);
    }
    project.suite.suites = [...files.values()];
  }

  async workspaceChanged(change: WorkspaceChange) {
    const testDirs = [...new Set([...this._projects.values()].map(p => p.project.testDir))];

    const changed = this._mapFilesToSources(testDirs, change.changed);
    const created = this._mapFilesToSources(testDirs, change.created);
    const deleted = this._mapFilesToSources(testDirs, change.deleted);

    if (created.length || deleted.length)
      await this._listFiles();
    if (changed.length) {
      const changedWithListedTests = changed.filter(f => this._filesWithListedTests.has(f));
      for (const c of changedWithListedTests)
        this._filesWithListedTests.delete(c);
      await this.ensureTests(changedWithListedTests);
    }
  }

  async ensureTests(inputFiles: string[]): Promise<void> {
    const enabledFiles = this.enabledFiles();
    const filesToListTests = inputFiles.filter(f => enabledFiles.has(f) && !this._filesWithListedTests.has(f));
    if (!filesToListTests.length)
      return;

    for (const file of filesToListTests)
      this._filesWithListedTests.add(file);

    if (!this._filesPendingListTests) {
      let finishedCallback!: () => void;
      const promise = new Promise<void>(f => finishedCallback = f);
      const files = new Set<string>();

      const timer = setTimeout(async () => {
        delete this._filesPendingListTests;
        await this._listTests([...files]).catch(e => console.log(e));
        finishedCallback();
      }, 100);

      this._filesPendingListTests = {
        files,
        finishedCallback,
        promise,
        timer,
      };
    }

    for (const file of filesToListTests)
      this._filesPendingListTests.files.add(file);

    return this._filesPendingListTests.promise;
  }

  private async _listTests(files: string[]) {
    const errors: reporterTypes.TestError[] = [];
    let rootSuite: reporterTypes.Suite | undefined;
    await this._playwrightTest.test(files, 'list', {}, {
      onBegin: (suite: reporterTypes.Suite) => {
        rootSuite = suite;
      },
      onError: (error: reporterTypes.TestError) => {
        errors.push(error);
      },
    }, new this._vscode.CancellationTokenSource().token);
    this._updateProjects(rootSuite!.suites, files, errors);
  }

  private _updateProjects(newProjectSuites: reporterTypes.Suite[], requestedFiles: string[], errors: reporterTypes.TestError[]) {
    for (const requestedFile of requestedFiles)
      this._errorByFile.deleteAll(requestedFile);
    for (const error of errors) {
      if (error.location)
        this._errorByFile.set(error.location.file, error);
    }

    for (const [projectName, project] of this._projects) {
      const files = projectFiles(project);
      const newProjectSuite = newProjectSuites.find(e => e.project()!.name === projectName);
      const filesToClear = new Set(requestedFiles);
      for (const fileSuite of newProjectSuite?.suites || []) {
        // Do not show partial results in suites with errors.
        if (this._errorByFile.has(fileSuite.location!.file))
          continue;
        filesToClear.delete(fileSuite.location!.file);
        files.set(fileSuite.location!.file, fileSuite);
      }

      for (const file of filesToClear) {
        const fileSuite = files.get(file);
        if (fileSuite) {
          fileSuite.suites = [];
          fileSuite.tests = [];
        }
      }
      project.suite.suites = [...files.values()];
    }
    this._didUpdate.fire();
  }

  updateFromRunningProjects(projectSuites: reporterTypes.Suite[]) {
    for (const projectSuite of projectSuites) {
      const project = this._projects.get(projectSuite.project()!.name);
      if (project)
        this._updateFromRunningProject(project, projectSuite);
    }
  }

  private _updateFromRunningProject(project: TestProject, projectSuite: reporterTypes.Suite) {
    // When running tests, don't remove existing entries.
    const files = projectFiles(project);
    for (const fileSuite of projectSuite.suites) {
      if (!fileSuite.allTests().length)
        continue;
      this._filesWithListedTests.add(fileSuite.location!.file);
      const existingFileSuite = files.get(fileSuite.location!.file);
      if (!existingFileSuite || !existingFileSuite.allTests().length)
        files.set(fileSuite.location!.file, fileSuite);
    }
    project.suite.suites = [...files.values()];
    this._didUpdate.fire();
  }

  async runTests(projects: TestProject[], locations: string[] | null, reporter: reporterTypes.ReporterV2, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    locations = locations || [];
    const locationArg = locations ? locations : [];
    if (token?.isCancellationRequested)
      return;
    const externalOptions = await this._options.runHooks.onWillRunTests(this.config, false);
    const showBrowser = this._options.settingsModel.showBrowser.get() && !!externalOptions.connectWsEndpoint;

    let trace: 'on' | 'off' | undefined;
    if (this._options.settingsModel.showTrace.get())
      trace = 'on';
    // "Show browser" mode forces context reuse that survives over multiple test runs.
    // Playwright Test sets up `tracesDir` inside the `test-results` folder, so it will be removed between runs.
    // When context is reused, its ongoing tracing will fail with ENOENT because trace files
    // were suddenly removed. So we disable tracing in this case.
    if (this._options.settingsModel.showBrowser.get())
      trace = 'off';

    const options: PlaywrightTestRunOptions = {
      grep: parametrizedTestTitle,
      projects: projects.length ? projects.map(p => p.name).filter(Boolean) : undefined,
      headed: showBrowser && !this._options.isUnderTest,
      workers: showBrowser ? 1 : undefined,
      trace,
      reuseContext: showBrowser,
      connectWsEndpoint: showBrowser ? externalOptions.connectWsEndpoint : undefined,
    };

    try {
      if (token?.isCancellationRequested)
        return;
      await this._playwrightTest.test(locationArg, 'test', options, reporter, token);
    } finally {
      await this._options.runHooks.onDidRunTests(false);
    }
  }

  async debugTests(projects: TestProject[], locations: string[] | null, reporter: reporterTypes.ReporterV2, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    locations = locations || [];
    const testDirs = projects.map(p => p.project.testDir);
    const configFolder = path.dirname(this.config.configFile);
    const configFile = path.basename(this.config.configFile);
    locations = locations || [];
    const escapedLocations = locations.map(escapeRegex);
    const args = ['test',
      '-c', configFile,
      ...escapedLocations,
      '--headed',
      ...projects.map(p => p.name).filter(Boolean).map(p => `--project=${p}`),
      '--repeat-each', '1',
      '--retries', '0',
      '--timeout', '0',
      '--workers', '1'
    ];
    if (parametrizedTestTitle)
      args.push(`--grep=${escapeRegex(parametrizedTestTitle)}`);

    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex);
      this._log(`${escapeRegex(path.relative(this.config.workspaceFolder, configFolder))}> debug -c ${configFile}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }

    const reporterServer = new ReporterServer(this._vscode);
    const testOptions = await this._options.runHooks.onWillRunTests(this.config, true);
    try {
      await this._vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: debugSessionName,
        request: 'launch',
        cwd: configFolder,
        env: {
          ...process.env,
          CI: this._options.isUnderTest ? undefined : process.env.CI,
          ...this._envProvider(),
          PW_TEST_CONNECT_WS_ENDPOINT: testOptions.connectWsEndpoint,
          ...(await reporterServer.env()),
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
          FORCE_COLOR: '1',
          PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
          PW_TEST_SOURCE_TRANSFORM_SCOPE: testDirs.join(pathSeparator),
          PW_TEST_HTML_REPORT_OPEN: 'never',
          PWDEBUG: 'console',
        },
        program: this.config.cli,
        args,
      });
      await reporterServer.wireTestListener('test', reporter, token);
    } finally {
      await this._options.runHooks.onDidRunTests(true);
    }
  }

  private _log(line: string) {
    this._options.playwrightTestLog.push(line);
  }

  private _mapFilesToSources(testDirs: string[], files: Set<string>): string[] {
    const result = new Set<string>();
    for (const file of files) {
      if (!testDirs.some(t => file.startsWith(t + path.sep)))
        continue;
      const sources = this._fileToSources.get(file);
      if (sources)
        sources.forEach(f => result.add(f));
      else
        result.add(file);
    }
    return [...result];
  }

  async findRelatedTestFiles(files: string[]) {
    return await this._playwrightTest.findRelatedTestFiles(files);
  }
}

export class TestModelCollection extends DisposableBase {
  private _models: TestModel[] = [];
  private _selectedConfigFile: string | undefined;
  private _didUpdate: vscodeTypes.EventEmitter<void>;
  readonly onUpdated: vscodeTypes.Event<void>;
  private _settingsModel: SettingsModel;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel) {
    super();
    this._settingsModel = settingsModel;
    this._didUpdate = new vscode.EventEmitter();
    this.onUpdated = this._didUpdate.event;
  }

  setModelEnabled(configFile: string, enabled: boolean) {
    const model = this._models.find(m => m.config.configFile === configFile);
    if (!model)
      return;
    if (model.isEnabled === enabled)
      return;
    model.isEnabled = enabled;
    this._saveSettings();
    model.reset();
    this._loadModelIfNeeded(model).then(() => this._didUpdate.fire());
  }

  setProjectEnabled(configFile: string, name: string, enabled: boolean) {
    const model = this._models.find(m => m.config.configFile === configFile);
    if (!model)
      return;
    const project = model.projectMap().get(name);
    if (!project)
      return;
    if (project.isEnabled === enabled)
      return;
    project.isEnabled = enabled;
    this._saveSettings();
    this._didUpdate.fire();
  }

  testDirs(): string[] {
    const result = new Set<string>();
    for (const model of this._models) {
      for (const dir of model.testDirs())
        result.add(dir);
    }
    return [...result];
  }

  async addModel(model: TestModel) {
    this._models.push(model);
    const workspaceSettings = this._settingsModel.workspaceSettings.get();
    const configSettings = (workspaceSettings.configs || []).find(c => c.relativeConfigFile === path.relative(model.config.workspaceFolder, model.config.configFile));
    model.isEnabled = configSettings?.enabled || (this._models.length === 1 && !configSettings);
    await this._loadModelIfNeeded(model);
    this._disposables.push(model.onUpdated(() => this._didUpdate.fire()));
    this._didUpdate.fire();
  }

  private async _loadModelIfNeeded(model: TestModel) {
    if (!model.isEnabled)
      return;
    await model._listFiles();
    const workspaceSettings = this._settingsModel.workspaceSettings.get();
    const configSettings = (workspaceSettings.configs || []).find(c => c.relativeConfigFile === path.relative(model.config.workspaceFolder, model.config.configFile));
    if (configSettings) {
      let firstProject = true;
      for (const project of model.projects()) {
        const projectSettings = configSettings.projects.find(p => p.name === project.name);
        if (projectSettings)
          project.isEnabled = projectSettings.enabled;
        else if (firstProject)
          project.isEnabled = true;
        firstProject = false;
      }
    } else {
      if (model.projects().length)
        model.projects()[0].isEnabled = true;
    }
  }

  hasEnabledModels() {
    return !!this.enabledModels().length;
  }

  versions(): Map<number, TestModel>{
    const versions = new Map<number, TestModel>();
    for (const model of this._models)
      versions.set(model.config.version, model);
    return versions;
  }

  clear() {
    this.dispose();
    for (const model of this._models)
      model.reset();
    this._models = [];
    this._didUpdate.fire();
  }

  enabledModels(): TestModel[] {
    return this._models.filter(m => m.isEnabled);
  }

  models(): TestModel[] {
    return this._models;
  }

  selectedModel(): TestModel | undefined {
    const model = this._models.find(m => m.config.configFile === this._selectedConfigFile);
    if (model)
      return model;
    return this._models.find(m => m.isEnabled);
  }

  selectModel(configFile: string) {
    this._selectedConfigFile = configFile;
    this._saveSettings();
    this._didUpdate.fire();
  }

  private _saveSettings() {
    const workspaceSettings: WorkspaceSettings = { configs: [] };
    for (const model of this._models) {
      workspaceSettings.configs!.push({
        relativeConfigFile: path.relative(model.config.workspaceFolder, model.config.configFile),
        selected: model.config.configFile === this._selectedConfigFile,
        enabled: model.isEnabled,
        projects: model.projects().map(p => ({ name: p.name, enabled: p.isEnabled })),
      });
    }
    this._settingsModel.workspaceSettings.set(workspaceSettings);
  }
}

export function projectFiles(project: TestProject): Map<string, reporterTypes.Suite> {
  const files = new Map<string, reporterTypes.Suite>();
  for (const fileSuite of project.suite.suites)
    files.set(fileSuite.location!.file, fileSuite);
  return files;
}

const listFilesFlag = Symbol('listFilesFlag');
