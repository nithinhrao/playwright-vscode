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

import { expect as baseExpect, test as baseTest, Browser, chromium, Page } from '@playwright/test';
import { Extension } from '../out/extension';
import { TestController, VSCode, WorkspaceFolder } from './mock/vscode';
import path from 'path';

type ActivateResult = {
  vscode: VSCode,
  testController: TestController;
  workspaceFolder: WorkspaceFolder;
};

type TestFixtures = {
  vscode: VSCode,
  activate: (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][], env?: Record<string, any> }) => Promise<ActivateResult>;
};

export type WorkerOptions = {
  useTestServer: boolean;
  showBrowser: boolean;
  vsCodeVersion: number;
};

// Make sure connect tests work with the locally-rolled version.
process.env.PW_VERSION_OVERRIDE = require('@playwright/test/package.json').version;

export const expect = baseExpect.extend({
  async toHaveTestTree(testController: TestController, expectedTree: string) {
    try {
      await expect.poll(() => testController.renderTestTree()).toBe(expectedTree);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => e.toString()
      };
    }
  },

  async toHaveExecLog(vscode: VSCode, expectedLog: string) {
    if (vscode.extensions[0]._settingsModel.useTestServer.get())
      return { pass: true, message: () => '' };
    try {
      await expect.poll(() => vscode.renderExecLog('  ')).toBe(expectedLog);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => e.toString()
      };
    }
  },

  async toHaveProjectTree(vscode: VSCode, expectedTree: string) {
    try {
      await expect.poll(() => vscode.renderProjectTree().then(s => s.trim().replace(/\\/, '/'))).toBe(expectedTree.trim());
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => e.toString()
      };
    }
  }
});

export const test = baseTest.extend<TestFixtures, WorkerOptions>({
  useTestServer: [false, { option: true, scope: 'worker' }],
  showBrowser: [false, { option: true, scope: 'worker' }],
  vsCodeVersion: [1.86, { option: true, scope: 'worker' }],

  vscode: async ({ browser, vsCodeVersion }, use) => {
    await use(new VSCode(vsCodeVersion, path.resolve(__dirname, '..'), browser));
  },

  activate: async ({ vscode, showBrowser, useTestServer }, use, testInfo) => {
    const instances: VSCode[] = [];
    await use(async (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][], env?: Record<string, any> }) => {
      if (options?.workspaceFolders) {
        for (const wf of options?.workspaceFolders)
          await vscode.addWorkspaceFolder(wf[0], wf[1]);
      } else {
        await vscode.addWorkspaceFolder(options?.rootDir || testInfo.outputDir, files);
      }

      const configuration = vscode.workspace.getConfiguration('playwright');
      if (options?.env)
        configuration.update('env', options.env);
      if (showBrowser)
        configuration.update('reuseBrowser', true);
      if (useTestServer)
        configuration.update('useTestServer', true);

      const extension = new Extension(vscode);
      vscode.extensions.push(extension);
      await vscode.activate();

      instances.push(vscode);
      return {
        vscode,
        testController: vscode.testControllers[0],
        workspaceFolder: vscode.workspace.workspaceFolders[0],
      };
    });
    for (const vscode of instances)
      vscode.dispose();
  },
});

export async function connectToSharedBrowser(vscode: VSCode) {
  await expect.poll(() => vscode.extensions[0].browserServerWSForTest()).toBeTruthy();
  const wsEndpoint = vscode.extensions[0].browserServerWSForTest();
  return await chromium.connect(wsEndpoint, {
    headers: { 'x-playwright-reuse-context': '1' }
  });
}

export async function waitForPage(browser: Browser) {
  let pages: Page[] = [];
  await expect.poll(async () => {
    const context = await (browser as any)._newContextForReuse();
    pages = context.pages();
    return pages.length;
  }).toBeTruthy();
  return pages[0];
}

export async function enableConfigs(vscode: VSCode, labels: string[]) {
  let success = false;
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  while (!success) {
    vscode.window.mockQuickPick = async items => {
      let allFound = true;
      for (const label of labels) {
        if (!items.find(i => i.label === label))
          allFound = false;
      }
      // Wait for all the selected options to become available, discard.
      if (!allFound) {
        await new Promise(f => setTimeout(f, 100));
        return undefined;
      }
      success = true;
      return items.filter(i => labels.includes(i.label));
    };
    await webView.getByTitle('Toggle Playwright Configs').click();
  }
}

export async function selectConfig(vscode: VSCode, label: string) {
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.locator('select').selectOption({ label });
}

export async function enableProjects(vscode: VSCode, projects: string[]) {
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  const projectLocators = await webView.getByTestId('projects').locator('div').locator('label').all();
  for (const projectLocator of projectLocators) {
    const name = await projectLocator.textContent();
    await projectLocator.locator('input').setChecked(projects.includes(name!));
  }
}
