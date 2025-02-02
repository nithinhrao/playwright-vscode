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

import { TestRun } from './mock/vscode';
import { expect, test } from './utils';

test.beforeEach(async ({ vscode }) => {
  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('allowWatchingFiles', true);
});

test('should watch all tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
    'tests/test-2.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should fail', async () => { expect(1).toBe(2); });
    `,
  });

  await testController.watch();
  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test-1.spec.ts', `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test-1.spec.ts > should pass [2:0]
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright find-related-test-files -c playwright.config.js
    > playwright test -c playwright.config.js tests/test-1.spec.ts
  `);
});

test('should unwatch all tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
    'tests/test-2.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should fail', async () => { expect(1).toBe(2); });
    `,
  });

  const watchRequest = await testController.watch();
  watchRequest.token.source.cancel();

  const testRuns: TestRun[] = [];
  testController.onDidCreateTestRun(testRun => { testRuns.push(testRun); });
  await workspaceFolder.changeFile('tests/test-1.spec.ts', `
    import { test } from '@playwright/test';
    test('should pass', async () => {});
  `);

  // Workspace observer has setTimeout(0) for coalescing.
  await new Promise(f => setTimeout(f, 500));

  expect(testRuns).toHaveLength(0);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should watch test file', async ({ activate }) => {
  const { testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
    'tests/test-2.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should fail', async () => { expect(1).toBe(2); });
    `,
  });

  const testItem2 = testController.findTestItems(/test-2/);
  await testController.watch(testItem2);

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test-1.spec.ts', `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `),
    workspaceFolder.changeFile('tests/test-2.spec.ts', `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test-2.spec.ts > should pass [2:0]
      enqueued
      started
      passed
  `);
});

test.skip('should watch tests via helper', async ({ activate }) => {
  // This test requires nightly playwright.
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/helper.ts': `
      export const foo = 42;
    `,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      import { foo } from './helper';
      test('should pass', async () => {
        expect(foo).toBe(42);
      });
    `,
  });

  await testController.watch();

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/helper.ts', `
      export const foo = 43;
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > should pass [2:0]
      enqueued
      started
      failed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright find-related-test-files -c playwright.config.js
    > playwright test -c playwright.config.js tests/test.spec.ts
  `);
});

test('should watch test in a file', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass 1/);
  await testController.watch(testItems);

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
      test('pass 3', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > pass 1 [2:0]
      enqueued
      enqueued
      started
      passed
  `);

  // first --list is for expand
  // second --list is for workspace change
  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright find-related-test-files -c playwright.config.js
    > playwright test -c playwright.config.js tests/test.spec.ts:3
  `);
});

test('should watch two tests in a file', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.watch(testItems);

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
      test('pass 3', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > pass 1 [2:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > pass 2 [3:0]
      enqueued
      enqueued
      started
      passed
  `);

  // first --list is for expand
  // second --list is for workspace change
  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright find-related-test-files -c playwright.config.js
    > playwright test -c playwright.config.js tests/test.spec.ts:3 tests/test.spec.ts:4
  `);
});
