/**
 * 离线冒烟测试：不启动浏览器、不连宿主，用桩件加载两个半边，验证
 *   ① loader id / 插件对象形状 / 两条槽位注册（sidebar.panellist + main）；
 *   ② 面板在「有数据」与「缺标准 props」两种情况下都能渲染不抛错；
 *   ③ 纯函数：分支树、未归入、可收编预演、共同目录、分组规范化/合并/删除；
 *   ④ Host 半边：分组文件读写、5 条路由的 happy path 与拒绝路径；
 *   ⑤ 静态约束：不 import Harness Client 包、只用主题 token、清单/文案/图标/patch 一致。
 *
 * 用法：D:\node.js\node.exe tools\verify.mjs（退出码 0 = 全过）
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let checks = 0;

/**
 * 断言包装，顺带计数。
 * @param {() => void} fn - 断言体。
 * @param {string} label - 用例名。
 */
function check(fn, label) {
  fn();
  checks += 1;
  console.log(`PASS ${label}`);
}

/**
 * 最小 localStorage 桩。
 * @returns {object} 存储对象。
 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
  Component: class Component {
    constructor(props) {
      this.props = props === undefined ? {} : props;
      this.state = {};
    }

    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    }
  },
};

let captured = null;
globalThis.__WORKSPACE_GRAPH_TEST__ = {};
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
  localStorage: makeStorage(),
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
};

// ------------------------------------------------------------------ 夹具

const nowMs = Date.parse('2026-11-05T22:00:00+08:00');
const minutesAgo = (n) => nowMs - n * 60 * 1000;

const snapshot = {
  items: [
    {
      workspaceId: 'w1',
      path: 'D:\\QAQ\\bookkeeping',
      title: '记账',
      sessionIds: ['session-b1', 'session-b2', 'session-missing'],
      createdAt: '2026-11-05T13:28:43.851Z',
      updatedAt: '2026-11-05T13:30:50.669Z',
    },
    {
      workspaceId: 'w2',
      path: 'D:\\QAQ',
      title: 'QAQ',
      sessionIds: [],
      createdAt: '2026-09-10T08:41:41.739Z',
      updatedAt: '2026-11-05T13:45:06.098Z',
    },
  ],
  archivedSessionIds: ['session-a1'],
  pinnedSessionIds: ['session-b2'],
  state: 'idle',
  phase: 'ready',
  error: null,
};

const list = {
  ids: ['session-b1', 'session-b2', 'session-a1', 'session-u1', 'session-u2', 'session-child'],
  byId: {
    'session-b1': {
      id: 'session-b1',
      title: '记账会话',
      displayTitle: '记账会话',
      cwd: 'D:\\QAQ\\bookkeeping',
      running: false,
      updatedAt: minutesAgo(5),
      retainedBy: {},
      blank: false,
    },
    'session-b2': {
      id: 'session-b2',
      title: 'fork 子会话',
      displayTitle: 'fork 子会话',
      cwd: 'D:\\QAQ\\bookkeeping',
      parentId: 'session-b1',
      running: true,
      updatedAt: minutesAgo(2),
      retainedBy: {},
      blank: false,
    },
    'session-a1': {
      id: 'session-a1',
      title: '旧会话',
      displayTitle: '旧会话',
      cwd: 'D:\\QAQ',
      running: false,
      updatedAt: minutesAgo(300),
      retainedBy: {},
      blank: false,
    },
    'session-u1': {
      id: 'session-u1',
      title: '未归入同目录',
      displayTitle: '未归入同目录',
      cwd: 'D:\\QAQ\\bookkeeping',
      running: false,
      updatedAt: minutesAgo(10),
      retainedBy: {},
      blank: false,
    },
    'session-u2': {
      id: 'session-u2',
      title: '未归入别目录',
      displayTitle: '未归入别目录',
      cwd: 'C:\\other',
      running: false,
      updatedAt: minutesAgo(20),
      retainedBy: {},
      blank: false,
    },
    'session-child': {
      id: 'session-child',
      title: '子代理会话',
      displayTitle: '子代理会话',
      cwd: 'D:\\QAQ',
      origin: 'subagent',
      running: false,
      updatedAt: minutesAgo(30),
      retainedBy: {},
      blank: false,
    },
  },
  phase: 'ready',
  projectionsBySession: {},
};

const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-session-atlas-'));
process.env.DSH_WORKSPACE_GRAPH_FILE = path.join(tempRoot, 'groups.json');

/**
 * 造一个极简请求。
 * @param {object} options - `{method, headers, json, rawBody}`。
 * @returns {object} 请求桩。
 */
function makeReq(options = {}) {
  const method = options.method === undefined ? 'GET' : options.method;
  const headers = options.headers === undefined ? {} : options.headers;
  const listeners = new Map();
  const req = {
    method,
    headers,
    on(event, callback) {
      const list = listeners.get(event);
      if (list === undefined) listeners.set(event, [callback]);
      else list.push(callback);
      return req;
    },
    destroy() {},
  };
  const text =
    options.rawBody !== undefined
      ? options.rawBody
      : options.json === undefined
        ? ''
        : JSON.stringify(options.json);
  setImmediate(() => {
    if (text !== '') {
      for (const callback of listeners.get('data') ?? []) callback(Buffer.from(text));
    }
    for (const callback of listeners.get('end') ?? []) callback();
  });
  return req;
}

/**
 * 造一个极简响应。
 * @returns {object} 响应桩。
 */
function makeRes() {
  const res = {
    status: 0,
    body: '',
    writeHead(code) {
      res.status = code;
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk);
    },
  };
  return res;
}

/**
 * 调一条路由并解析响应。
 * @param {object} route - `{handler}`。
 * @param {object} options - 请求参数。
 * @returns {Promise<{status: number, body: any, text: string}>} 结果。
 */
async function call(route, options) {
  const res = makeRes();
  await route.handler(makeReq(options), res);
  let body = null;
  try {
    body = res.body === '' ? null : JSON.parse(res.body);
  } catch {
    body = null;
  }
  return { status: res.status, body, text: res.body };
}

/**
 * 造一个工作区实体桩。
 * @param {string} id - 工作区 id。
 * @param {string} dir - 目录。
 * @param {string} title - 标题。
 * @returns {object} 实体。
 */
function makeEntity(id, dir, title) {
  const entity = {
    id,
    path: dir,
    title,
    sessionIds: [],
    async setTitle(value) {
      entity.title = value;
    },
    async attachSession(sessionId) {
      if (sessionId === 'session-bad') {
        throw new Error(`cannot attach session '${sessionId}' to workspace '${dir}': its cwd resolves to 'C:\\other'`);
      }
      if (sessionId === 'session-ghost') {
        throw new Error(`cannot validate session '${sessionId}': session persistence holds no such session`);
      }
      entity.sessionIds = [sessionId, ...entity.sessionIds];
    },
    async detachSession(sessionId) {
      entity.sessionIds = entity.sessionIds.filter((item) => item !== sessionId);
    },
  };
  return entity;
}

/**
 * 造一个注册表桩。
 * @param {object[]} seeded - 已有实体。
 * @returns {object} 注册表。
 */
function makeRegistry(seeded = []) {
  const entities = new Map();
  for (const entity of seeded) entities.set(entity.id, entity);
  const registry = {
    created: [],
    resolveByPath: async (dir) => Array.from(entities.values()).find((entity) => entity.path === dir),
    async create(dir, title) {
      if (dir === 'D:\\QAQ\\missing') throw new Error('ENOENT: no such file or directory');
      const entity = makeEntity(`w-created-${registry.created.length + 1}`, dir, title ?? 'created');
      registry.created.push(entity);
      entities.set(entity.id, entity);
      return entity;
    },
    get: (id) => entities.get(id),
    list: () => Array.from(entities.values()),
  };
  return registry;
}

try {
  // -------------------------------------------------------------- 客户端半边

  await import(pathToFileURL(path.join(root, 'client.js')).href);

  check(() => {
    assert.ok(captured !== null, 'client.js 没有调用 __ModuleLoader__.load');
    assert.equal(captured.id, 'dsh-session-atlas');
    assert.equal(typeof captured.factory, 'function');
  }, 'loader id 与 factory');

  const plugin = captured.factory((name) => {
    assert.equal(name, 'react');
    return reactStub;
  });
  const H = globalThis.__WORKSPACE_GRAPH_TEST__;

  check(() => {
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(plugin.name, 'workspace-graph');
    assert.ok(Array.isArray(plugin.inject));
    assert.ok(plugin.inject.includes('slots'));
    assert.ok(plugin.inject.includes('locale'));
  }, '插件对象形状');

  const regs = [];
  const dicts = new Map();
  const fakeCtx = {
    locale: {
      register(ns, locale, dict) {
        dicts.set(`${ns}:${locale}`, dict);
        return () => {};
      },
      bind(ns) {
        return (key) => {
          const dict = dicts.get(`${ns}:zh`);
          return dict === undefined || dict[key] === undefined ? key : dict[key];
        };
      },
      subscribe() {
        return () => {};
      },
    },
    slots: {
      inject(_name, callback) {
        return callback();
      },
      register(options, component) {
        regs.push({ options, component });
        return () => {};
      },
    },
    effect(callback) {
      return callback();
    },
    get() {
      return undefined;
    },
  };

  plugin.apply(fakeCtx);

  check(() => {
    assert.equal(regs.length, 2, `应恰好注册 2 条，实际 ${regs.length}`);
    assert.ok(dicts.has('workspaceGraph:zh'));
    assert.ok(dicts.has('workspaceGraph:en'));
  }, '两条槽位注册 + zh/en 词典');

  const sidebar = regs.find((entry) => entry.options.name === 'sidebar.panellist');
  const main = regs.find((entry) => entry.options.name === 'main');

  check(() => {
    assert.ok(sidebar, '缺少 sidebar.panellist 注册');
    assert.equal(sidebar.options.id, 'workspace-graph');
    assert.equal(sidebar.options.order, 120);
    assert.equal(sidebar.options.label(), '工作区图');
    assert.equal(typeof sidebar.component, 'function');
  }, '侧栏入口（id / order / label）');

  check(() => {
    assert.ok(main, '缺少 main 注册');
    assert.equal(main.options.key, 'workspace-graph');
    assert.equal(typeof main.component, 'function');
  }, '主面板（key）');

  check(() => {
    const active = sidebar.component({ size: 16, active: true });
    const idle = sidebar.component({ size: 0, active: false });
    assert.equal(active.type, 'svg');
    assert.equal(active.props.width, 16);
    assert.equal(idle.props.width, 16, 'size 兜底应为 16');
    assert.ok(active.children.length >= 5);
  }, '图标组件渲染');

  check(() => {
    assert.equal(typeof main.component, 'function');
    assert.ok(H !== null && typeof H.renderPanel === 'function', 'apply 应把内部 Panel 暴露给测试钩子');
  }, '主面板经过错误边界包装');

  check(() => {
    const Panel = H.renderPanel;
    const tree = Panel({
      useWorkspaces: () => snapshot,
      useSessions: () => list,
      useSessionStatus: () => new Map(),
    });
    assert.equal(tree.type, 'div');
    assert.equal(tree.props.className, 'wg2-root');
    const style = tree.children.find((child) => child !== null && child.type === 'style');
    assert.ok(style, '面板应内联一份样式');
    const css = String(style.children[0]);
    assert.ok(css.includes('--dsw-alias-'));
    assert.ok(css.includes('.wg2-canvas'), '节点画布样式应存在');
    assert.ok(css.includes('.wg2-edge-'), '连线样式应存在');
    const dump = JSON.stringify(tree);
    assert.ok(dump.includes('wg2-canvas'), '完整数据下应渲染画布');
    assert.ok(dump.includes('wg2-node-ws'), '应渲染工作区节点');
    assert.ok(dump.includes('wg2-edge-nest'), '目录父子连线应存在');
    assert.ok(dump.includes('wg2-recent'), '工作区节点应显示最近对话时间');
  }, '面板在完整数据下渲染节点图不抛错');

  check(() => {
    const Panel = H.renderPanel;
    const tree = Panel({});
    assert.equal(tree.type, 'div');
    assert.ok(JSON.stringify(tree).includes('wg2-root'));
  }, '面板在缺标准 props 时降级不抛错');

  check(() => {
    assert.equal(H.sessionState({ pendingInteraction: { kind: 'question' }, running: true }, {}), 'pending', '待处理优先于运行中');
    assert.equal(H.sessionState({ running: false }, { running: true }), 'idle', 'status.running 覆盖 summary.running');
    assert.equal(H.sessionState(undefined, { running: true }), 'running', '缺状态快照时回退 summary.running');
    assert.equal(H.sessionState({ completionUnread: true }, {}), 'done');
    assert.equal(H.sessionState({}, {}), 'idle');
    assert.equal(H.pendingKindOf({ pendingInteraction: { kind: 'plan-review' } }), 'plan-review');
    assert.equal(H.pendingKindOf({ pendingInteraction: { kind: 'other' } }), '');
    assert.deepEqual(H.statusOf({ s: { running: true } }, 's'), { running: true });
    assert.equal(H.statusOf(null, 's'), undefined);
    const statuses = new Map([
      ['a', { running: true }],
      ['b', { completionUnread: true }],
    ]);
    assert.deepEqual(
      H.aggregateStates(
        ['a', 'b', 'archived', 'sub', 'missing'],
        { a: {}, b: {}, archived: {}, sub: { origin: 'subagent' } },
        statuses,
        new Set(['archived']),
      ),
      { pending: 0, running: 1, done: 1 },
      '聚合跳过归档、子代理与不存在的会话',
    );
    assert.deepEqual(H.aggregateStates(undefined, {}, null), { pending: 0, running: 0, done: 0 });
    assert.equal(H.nodeAccentState({ kind: 'sess', state: 'running' }), 'running', '会话色条取自身状态');
    assert.equal(H.nodeAccentState({ kind: 'ws', states: { pending: 1, running: 2, done: 3 } }), 'pending', '容器色条取最高优先级');
    assert.equal(H.nodeAccentState({ kind: 'ws', states: { pending: 0, running: 0, done: 2 } }), 'done');
    assert.equal(H.nodeAccentState({ kind: 'ws', states: { pending: 0, running: 0, done: 0 } }), '', '空闲节点没有状态色条');
  }, '状态优先级与聚合');

  check(() => {
    const Panel = H.renderPanel;
    const statuses = new Map([
      ['session-b1', { pendingInteraction: { kind: 'approval' } }],
      ['session-b2', { running: true }],
      ['session-u1', { completionUnread: true }],
    ]);
    const tree = Panel({
      useWorkspaces: () => snapshot,
      useSessions: () => list,
      useSessionStatus: () => statuses,
    });
    const dump = JSON.stringify(tree);
    assert.ok(dump.includes('wg2-state-pending'), '工作区节点应出现待处理角标');
    assert.ok(dump.includes('wg2-state-running'), '工作区节点应出现运行中角标');
    assert.ok(dump.includes('wg2-state-done'), '未归入节点应聚合出未读完成');
    assert.ok(dump.includes('wg2-totals'), '顶部工具栏应有全局状态汇总');
    assert.ok(dump.includes('待处理'), '概览面板应显示状态文案');
    assert.ok(dump.includes('wg2-node-ws is-state-pending'), '工作区节点左侧应有待处理色条');
    assert.ok(dump.includes('wg2-node-unassigned is-state-done'), '未归入节点左侧应有完成色条');
    const css = String(tree.children.find((child) => child !== null && child.type === 'style').children[0]);
    assert.ok(css.includes('--dsw-alias-state-success-primary'), '未读完成应使用绿色 success token');
    assert.ok(css.includes('is-state-pending'), '节点应带状态色条样式');
  }, '状态角标：工作区聚合 / 顶部汇总 / 概览');

  check(() => {
    // 真正跑一遍 effects + 点一次展开箭头：静态渲染测试不执行 useEffect，漏过 minX 那类 bug。
    const output = execFileSync(process.execPath, [path.join(here, 'render-smoke.mjs')], { encoding: 'utf8', cwd: root });
    assert.ok(output.includes('SMOKE OK'), output);
  }, '交互冒烟：点开工作区箭头（effects + 展开/收起跟随）');

  // ---------------------------------------------------------------- 纯函数


  check(() => {
    assert.ok(H !== null && typeof H === 'object');
    const names = [
      'nestRows',
      'unassignedRows',
      'partitionAdoptable',
      'mergeGroupList',
      'normalizeGroups',
      'Icon',
      'containerKey',
      'sessionKey',
      'pathParentOf',
      'buildWorkspaceForest',
      'readTishiHiddenWorkspaceIds',
      'sessionForkDepth',
      'buildGraph',
      'sessionState',
      'pendingKindOf',
      'statusOf',
      'aggregateStates',
      'compareNodes',
      'placeNodes',
      'edgePath',
      'buildEdgePaths',
      'worldBounds',
      'clampZoom',
      'screenToWorld',
      'worldToScreen',
      'fitViewport',
      'followViewport',
      'anyNodeVisible',
      'rectsOverlap',
      'nearestFreeShift',
      'separateManualNodes',
      'normalizeLayout',
      'compareSessionsForDisplay',
      'latestActivity',
      'formatAbsoluteTime',
    ];
    for (const name of names) {
      assert.equal(typeof H[name], 'function', `缺少测试钩子 ${name}`);
    }
    assert.equal(H.PANEL_ID, 'workspace-graph');
    assert.equal(H.ROUTES.state, '/workspace-graph/state');
    assert.equal(H.ROUTES.layout, '/workspace-graph/layout');
    assert.equal(H.NODE_SIZE.ws.w, 280);
    assert.equal(H.NODE_SIZE.sess.h, 56, '会话节点两行高：标题+时间 / 徽标');
  }, '测试钩子已导出');

  check(() => {
    assert.equal(H.canonicalKey('D:\\QAQ\\Bookkeeping\\'), 'd:/qaq/bookkeeping');
    assert.equal(H.canonicalKey('d:/qaq/bookkeeping'), 'd:/qaq/bookkeeping');
    assert.equal(H.canonicalKey(''), '');
    assert.equal(H.canonicalKey(null), '');
    assert.equal(H.basenameOf('D:\\QAQ\\bookkeeping\\'), 'bookkeeping');
    assert.equal(H.basenameOf('D:/QAQ/bookkeeping'), 'bookkeeping');
    assert.equal(H.basenameOf(''), '');
    assert.equal(H.summaryTitle({ title: '  标题  ' }), '标题');
    assert.equal(H.summaryTitle({ displayTitle: '投影标题' }), '投影标题');
    assert.equal(H.summaryTitle({ id: 'session-x' }), 'session-x');
  }, '路径/标题工具');

  check(() => {
    const rows = H.nestRows(['session-b1', 'session-b2', 'session-missing'], list.byId);
    assert.deepEqual(rows, [
      { id: 'session-b1', depth: 0 },
      { id: 'session-b2', depth: 1 },
    ]);
  }, '分支树：fork 子会话缩进、缺失成员丢弃');
  check(() => {
    const byId = {
      a: { id: 'a', parentId: 'b' },
      b: { id: 'b', parentId: 'a' },
      c: { id: 'c', parentId: 'zzz' },
    };
    const rows = H.nestRows(['a', 'b', 'c'], byId);
    assert.equal(rows.length, 3, '成环数据也必须每行只出现一次');
    assert.equal(rows.find((row) => row.id === 'c').depth, 0, '父不在成员里应降为顶层');
  }, '分支树：成环保护与前缀孤儿');

  check(() => {
    const options = { showArchived: false, showSubagent: false, archivedIds: new Set(['session-a1']) };
    const rows = H.unassignedRows(list, snapshot.items, options);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['session-u1', 'session-u2'],
      '归档与子代理会话隐藏；已归入的不出现',
    );
    const withArchived = H.unassignedRows(list, snapshot.items, { showArchived: true, showSubagent: true, archivedIds: new Set() });
    assert.ok(withArchived.some((row) => row.id === 'session-a1'));
    assert.ok(withArchived.some((row) => row.id === 'session-child'));
  }, '未归入：可见性开关与归属过滤');

  check(() => {
    const visible = H.workspaceRows(snapshot.items[0], list, { showArchived: false, showSubagent: false, archivedIds: new Set() });
    assert.deepEqual(visible.map((row) => row.id), ['session-b1', 'session-b2']);
  }, '工作区行：成员过滤 + 树上顺序');

  check(() => {
    const preview = H.partitionAdoptable(['session-b1', 'session-u1', 'session-u2'], list.byId, 'D:\\QAQ\\BOOKKEEPING\\');
    assert.deepEqual(preview.accepted, ['session-b1', 'session-u1'], '大小写/尾斜杠不应影响预演');
    assert.deepEqual(preview.rejected, [{ id: 'session-u2', reason: 'cwd-mismatch' }]);
    const noCwd = H.partitionAdoptable(['session-nope'], list.byId, 'D:\\QAQ');
    assert.deepEqual(noCwd.rejected, [{ id: 'session-nope', reason: 'not-found' }]);
  }, '可收编预演：同目录接受、异目录拒绝');

  check(() => {
    assert.equal(H.commonDirectory(['session-b1', 'session-b2'], list.byId), 'D:\\QAQ\\bookkeeping');
    assert.equal(H.commonDirectory(['session-b1', 'session-u2'], list.byId), '');
    assert.equal(H.commonDirectory([], list.byId), '');
  }, '共同目录推断');

  check(() => {
    assert.equal(H.suggestWorkspace(list.byId['session-u1'], snapshot.items).workspaceId, 'w1');
    assert.equal(H.suggestWorkspace(list.byId['session-u2'], snapshot.items), null);
    assert.equal(H.workspaceOf(list.byId['session-b1'], snapshot.items).workspaceId, 'w1');
    assert.equal(H.workspaceOf(list.byId['session-u1'], snapshot.items), null);
  }, '归属提示（可并入 / 已在哪个工作区）');

  check(() => {
    const groups = H.normalizeGroups({
      groups: [
        { id: 'g1', title: '  一组  ', sessionIds: ['session-a1', 'session-a1', 'bad id', 12] },
        { id: 'g1', title: '重复 id', sessionIds: [] },
        { title: '', sessionIds: [] },
        'not-object',
      ],
    });
    assert.equal(groups.length, 3);
    assert.equal(groups[0].title, '一组');
    assert.deepEqual(groups[0].sessionIds, ['session-a1']);
    assert.notEqual(groups[1].id, 'g1', '重复 id 必须换新');
    assert.equal(groups[2].title, '');
  }, '分组规范化：去重 / 裁标题 / 丢非法');

  check(() => {
    let groups = [];
    const added = H.addGroup(groups, '新组', ['session-a1', 'session-a1', 'session-b1']);
    assert.equal(added.groups.length, 1);
    assert.deepEqual(added.group.sessionIds, ['session-a1', 'session-b1']);
    groups = added.groups;
    const second = H.addGroup(groups, '第二组', ['session-b2']);
    groups = second.groups;
    assert.equal(groups.length, 2);
    assert.equal(groups[0].id, second.group.id, '新组放最前');

    const merged = H.mergeGroupList(groups, [added.group.id, second.group.id], '合并');
    assert.equal(merged.groups.length, 1);
    // 并集顺序按分组列表顺序（新组在前），不是点击顺序，保证结果稳定可复现。
    assert.deepEqual(merged.group.sessionIds, ['session-b2', 'session-a1', 'session-b1']);
    assert.equal(merged.groups[0].id, merged.group.id);

    const renamed = H.renameGroup(merged.groups, merged.group.id, '改个名');
    assert.equal(renamed[0].title, '改个名');
    assert.equal(H.removeGroups(renamed, [merged.group.id]).length, 0);
  }, '分组增删改合并');

  check(() => {
    const first = H.emptySelection();
    const second = H.toggleIn(first, 'sessions', 'session-b1');
    assert.equal(first.sessions.size, 0, '选择态必须返回新对象');
    assert.equal(second.sessions.size, 1);
    const third = H.toggleIn(second, 'sessions', 'session-b1');
    assert.equal(third.sessions.size, 0);
  }, '选择态不可变切换');

  check(() => {
    const now = new Date('2026-11-05T22:00:00+08:00');
    assert.deepEqual(H.timeParts(now.getTime() - 10 * 1000, now), { kind: 'justNow' });
    assert.deepEqual(H.timeParts(now.getTime() - 5 * 60 * 1000, now), { kind: 'minutes', n: 5 });
    assert.deepEqual(H.timeParts(now.getTime() - 2 * 3600 * 1000, now), { kind: 'hours', n: 2 });
    const today = H.timeParts(now.getTime() - 8 * 3600 * 1000, now);
    assert.equal(today.kind, 'today');
    assert.equal(H.timeParts('nope', now), null);
    assert.equal(H.timeParts(undefined, now), null);
  }, '相对时间分档');

  // ------------------------------------------------------------ 节点图纯函数

  const graphWorkspaces = [
    { workspaceId: 'w1', path: 'D:\\QAQ', title: 'QAQ', sessionIds: ['session-b1', 'session-b2', 'session-a1', 'session-child'] },
    { workspaceId: 'w2', path: 'D:\\QAQ\\bookkeeping', title: '记账', sessionIds: ['session-u1'] },
    { workspaceId: 'w3', path: 'D:\\QAQX', title: '相似前缀', sessionIds: [] },
  ];
  const graphSessions = {
    ids: ['session-b1', 'session-b2', 'session-a1', 'session-u1', 'session-u2', 'session-child'],
    byId: {
      'session-b1': { id: 'session-b1', title: '根会话', cwd: 'D:\\QAQ', updatedAt: minutesAgo(5) },
      'session-b2': { id: 'session-b2', title: 'fork 子', cwd: 'D:\\QAQ', parentId: 'session-b1', updatedAt: minutesAgo(4) },
      'session-a1': { id: 'session-a1', title: '归档的', cwd: 'D:\\QAQ', updatedAt: minutesAgo(6) },
      'session-u1': { id: 'session-u1', title: '记账会话', cwd: 'D:\\QAQ\\bookkeeping', updatedAt: minutesAgo(3) },
      'session-u2': { id: 'session-u2', title: '无主会话', cwd: 'C:\\other', updatedAt: minutesAgo(2) },
      'session-child': { id: 'session-child', title: '子代理', cwd: 'D:\\QAQ', origin: 'subagent', updatedAt: minutesAgo(1) },
    },
  };
  const graphOptions = { showArchived: false, showSubagent: false, archivedIds: new Set(['session-a1']) };

  check(() => {
    const statuses = new Map([
      ['session-b1', { pendingInteraction: { kind: 'plan-review' }, running: true }],
      ['session-b2', { running: false }],
      ['session-a1', { running: true }],
      ['session-child', { running: true }],
      ['session-u2', { completionUnread: true }],
    ]);
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(['ws:w1', 'unassigned']),
      showGroups: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
      statuses,
    });
    const w1 = graph.nodes.find((node) => node.key === 'ws:w1');
    assert.deepEqual(w1.states, { pending: 1, running: 0, done: 0 }, '工作区聚合：待处理优先，归档/子代理不计');
    const b1 = graph.nodes.find((node) => node.key === 'sess:session-b1');
    assert.equal(b1.state, 'pending');
    assert.equal(b1.pendingKind, 'plan-review');
    const b2 = graph.nodes.find((node) => node.key === 'sess:session-b2');
    assert.equal(b2.state, 'idle', 'status.running=false 覆盖 summary.running');
    const u2 = graph.nodes.find((node) => node.key === 'sess:session-u2');
    assert.equal(u2.state, 'done');
    assert.deepEqual(graph.nodes.find((node) => node.key === 'unassigned').states, { pending: 0, running: 0, done: 1 });
    assert.deepEqual(graph.stats.states, { pending: 1, running: 0, done: 1 }, '全局状态统计排除归档/子代理');
  }, '图节点带状态：会话 / 工作区 / 未归入 / 全局');

  check(() => {
    assert.equal(H.containerKey('ws', 'w1'), 'ws:w1');
    assert.equal(H.containerKey('grp', 'g1'), 'grp:g1');
    assert.equal(H.containerKey('unassigned'), 'unassigned');
    assert.equal(H.sessionKey('session-b1'), 'sess:session-b1');
  }, '节点键构造');

  check(() => {
    const forest = H.buildWorkspaceForest(graphWorkspaces);
    assert.equal(forest.roots.length, 2, 'QAQ 与 D:\\QAQX 都是根');
    assert.ok(forest.roots.includes('w1'));
    assert.ok(forest.roots.includes('w3'));
    assert.equal(forest.parentOf.get('w2'), 'w1', '记账的父是 QAQ');
    assert.equal(forest.parentOf.get('w3'), '', '相似前缀不能被当父子');
    assert.equal(forest.depthOf('w2'), 1);
    assert.equal(forest.depthOf('w1'), 0);
  }, '目录父子识别（含相似前缀）');

  check(() => {
    const storage = (raw) => ({ getItem: () => raw });
    assert.deepEqual([...H.readTishiHiddenWorkspaceIds(storage('{"v":1,"ids":["w1","w2","w2"]}'))], ['w1', 'w2']);
    assert.deepEqual([...H.readTishiHiddenWorkspaceIds(storage('["w3", 42, ""]'))], ['w3'], '兼容旧版裸数组，丢弃非字符串');
    assert.equal(H.readTishiHiddenWorkspaceIds(storage('{broken')).size, 0, '坏 JSON 视为没有隐藏');
    assert.equal(H.readTishiHiddenWorkspaceIds(storage(null)).size, 0);
    assert.equal(H.readTishiHiddenWorkspaceIds(null).size, 0);
    assert.equal(
      H.readTishiHiddenWorkspaceIds({
        getItem() {
          throw new Error('denied');
        },
      }).size,
      0,
      '存储不可读时退化为不隐藏',
    );
  }, 'dsh_tishi 隐藏工作区集合只读解析');

  check(() => {
    const hidden = new Set(['w1']);
    const base = {
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(['ws:w1', 'ws:w2']),
      showGroups: true,
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    };
    const hiddenGraph = H.buildGraph({ ...base, hiddenWorkspaceIds: hidden });
    const hiddenKeys = hiddenGraph.nodes.map((node) => node.key);
    assert.equal(hiddenKeys.includes('ws:w1'), false, '默认不画被侧栏隐藏的工作区');
    assert.equal(hiddenKeys.includes('sess:session-b1'), false, '被隐藏工作区的会话也不画');
    assert.equal(hiddenKeys.includes('sess:session-child'), false);
    assert.ok(hiddenKeys.includes('ws:w2'), '不连坐子工作区');
    assert.ok(hiddenKeys.includes('sess:session-u1'), '子工作区自己的会话照常可见');
    assert.equal(hiddenGraph.stats.hiddenWorkspaces, 1);
    assert.equal(hiddenGraph.stats.workspaces, 2, '概览工作区数不含被隐藏的');

    const shownGraph = H.buildGraph({ ...base, hiddenWorkspaceIds: hidden, showHidden: true });
    const shownKeys = shownGraph.nodes.map((node) => node.key);
    assert.ok(shownKeys.includes('ws:w1'), '开关打开后把隐藏工作区画出来');
    assert.ok(shownKeys.includes('sess:session-b1'));
    const shownWs = shownGraph.nodes.find((node) => node.key === 'ws:w1');
    assert.equal(shownWs.hiddenInSidebar, true, '放出后仍保留「侧栏已隐藏」标记，供样式与徽标使用');
    assert.equal(shownGraph.stats.workspaces, 3);
    assert.equal(shownGraph.stats.hiddenWorkspaces, 1, '计数保留，用户仍知道有几个被藏');

    const searchingGraph = H.buildGraph({ ...base, hiddenWorkspaceIds: hidden, query: '根会话' });
    assert.ok(searchingGraph.nodes.some((node) => node.key === 'ws:w1'), '搜索时不隐藏，保证命中可见');
    const focusGraph = H.buildGraph({
      ...base,
      hiddenWorkspaceIds: hidden,
      focusActive: true,
      statuses: new Map([['session-u1', { running: true }]]),
    });
    assert.ok(focusGraph.nodes.some((node) => node.key === 'ws:w1'), '只看进行中时不隐藏，保证祖先链可见');
  }, '图里隐藏侧栏隐藏的工作区（开关 / 搜索 / 聚焦）');

  check(() => {
    assert.equal(H.sessionForkDepth(graphSessions.byId['session-b2'], graphSessions.byId), 1);
    assert.equal(H.sessionForkDepth(graphSessions.byId['session-b1'], graphSessions.byId), 0);
    const byId = { a: { id: 'a', parentId: 'b' }, b: { id: 'b', parentId: 'a' } };
    assert.ok(H.sessionForkDepth(byId.a, byId) <= 4, '成环必须封顶');
  }, 'fork 世代');

  check(() => {
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(),
      showGroups: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    });
    const keys = graph.nodes.map((node) => node.key);
    assert.deepEqual(keys.sort(), ['unassigned', 'ws:w1', 'ws:w2', 'ws:w3'], '折叠时只有工作区节点 + 未归入');
    assert.equal(graph.unassignedCount, 1, '只有 session-u2 没有工作区');
    assert.deepEqual(
      graph.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`).sort(),
      ['nest:ws:w1->ws:w2'],
      '折叠时只画目录父子线',
    );
    assert.equal(graph.stats.workspaces, 3);
    assert.equal(graph.stats.sessions, 4, '统计用过滤后的总会话数，不是可见节点数');
    assert.equal(graph.stats.visibleSessions, 0, '折叠时没有可见会话节点');
    const w1 = graph.nodes.find((node) => node.key === 'ws:w1');
    assert.equal(w1.counts.sessions, 2, '归档/子代理开关影响计数');
    assert.equal(w1.layer, 0);
    assert.equal(graph.nodes.find((node) => node.key === 'ws:w2').layer, 1);
  }, '折叠态图：节点/连线/计数');

  check(() => {
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(['ws:w1', 'unassigned']),
      showGroups: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    });
    const keys = graph.nodes.map((node) => node.key);
    assert.ok(keys.includes('sess:session-b1'));
    assert.ok(keys.includes('sess:session-b2'));
    assert.ok(!keys.includes('sess:session-a1'), '归档会话默认隐藏');
    assert.ok(!keys.includes('sess:session-child'), '子代理会话默认隐藏');
    assert.ok(keys.includes('sess:session-u2'), '未归入展开后显示');
    const kinds = graph.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`);
    assert.ok(kinds.includes('member:ws:w1->sess:session-b1'));
    assert.ok(kinds.includes('fork:sess:session-b1->sess:session-b2'));
    assert.ok(kinds.includes('unassigned:unassigned->sess:session-u2'));
    const rootSession = graph.nodes.find((node) => node.key === 'sess:session-b1');
    const forkSession = graph.nodes.find((node) => node.key === 'sess:session-b2');
    assert.equal(rootSession.layer, 1, '工作区会话在下一列');
    assert.equal(forkSession.layer, 2, 'fork 子会更深一层');
  }, '展开态图：成员/血缘/未归入连线');

  check(() => {
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [{ id: 'g1', title: '组一', sessionIds: ['session-b1', 'session-u2'] }],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(['grp:g1']),
      showGroups: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    });
    const keys = graph.nodes.map((node) => node.key);
    assert.ok(keys.includes('grp:g1'));
    assert.ok(keys.includes('sess:session-b1'), '分组展开也能让会话可见');
    assert.ok(keys.includes('sess:session-u2'));
    const kinds = graph.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`);
    assert.ok(kinds.includes('group:sess:session-b1->grp:g1'));
    assert.ok(kinds.includes('group:sess:session-u2->grp:g1'));
    assert.ok(kinds.includes('member:ws:w1->sess:session-b1'), '可见会话仍画成员线');
    const groupNode = graph.nodes.find((node) => node.key === 'grp:g1');
    assert.ok(groupNode.layer > graph.nodes.find((node) => node.key === 'sess:session-u2').layer, '分组在成员右侧');
  }, '分组节点与虚线归属');

  check(() => {
    const build = (groups) =>
      H.buildGraph({
        workspaces: graphWorkspaces,
        groups,
        list: graphSessions,
        options: graphOptions,
        expanded: new Set(groups.map((group) => `grp:${group.id}`)),
        showGroups: true,
        query: '',
        groupFallbackTitle: '组',
        unassignedTitle: '未归入',
      });
    const graph = build([{ id: 'g1', title: '组一', sessionIds: ['session-b1', 'session-u2'] }]);
    const placed = H.placeNodes(graph.nodes, {});
    const groupRect = placed['grp:g1'];
    const memberRects = ['sess:session-b1', 'sess:session-u2'].map((key) => placed[key]);
    const maxRight = Math.max(...memberRects.map((rect) => rect.x + rect.w));
    const meanCenter = memberRects.reduce((sum, rect) => sum + rect.y + rect.h / 2, 0) / memberRects.length;
    assert.ok(groupRect.x >= maxRight, '分组应在成员右侧');
    assert.ok(groupRect.x - maxRight <= 160, `分组应贴着成员：gap=${groupRect.x - maxRight}`);
    assert.ok(Math.abs(groupRect.y + groupRect.h / 2 - meanCenter) <= 60, '分组纵向对齐成员中心');
    for (const [key, rect] of Object.entries(placed)) {
      if (key === 'grp:g1') continue;
      const clash = groupRect.x < rect.x + rect.w && rect.x < groupRect.x + groupRect.w && groupRect.y < rect.y + rect.h && rect.y < groupRect.y + groupRect.h;
      assert.equal(clash, false, `分组与 ${key} 重叠`);
    }
    // 两个分组锚在同一批成员时也要互相避让，不能叠在一起
    const twoGroups = build([
      { id: 'g1', title: '组一', sessionIds: ['session-b1'] },
      { id: 'g2', title: '组二', sessionIds: ['session-b1'] },
    ]);
    const placedTwo = H.placeNodes(twoGroups.nodes, {});
    const first = placedTwo['grp:g1'];
    const second = placedTwo['grp:g2'];
    const overlap = first.x < second.x + second.w && second.x < first.x + first.w && first.y < second.y + second.h && second.y < first.y + first.h;
    assert.equal(overlap, false, '两个分组要错开');
  }, '分组节点贴着成员会话排');

  check(() => {
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: { showArchived: true, showSubagent: true, archivedIds: new Set() },
      expanded: new Set(['ws:w1']),
      showGroups: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    });
    const keys = graph.nodes.map((node) => node.key);
    assert.ok(keys.includes('sess:session-a1'), '打开归档开关后应出现');
    assert.ok(keys.includes('sess:session-child'), '打开子代理开关后应出现');
  }, '归档/子代理开关');

  check(() => {
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(),
      showGroups: true,
      query: '记账',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    });
    const keys = graph.nodes.map((node) => node.key);
    assert.ok(keys.includes('sess:session-u1'), '搜索命中会无视折叠强制显示');
    assert.ok(!keys.includes('sess:session-b1'), '不匹配的会话不显示');
    assert.equal(graph.nodes.find((node) => node.key === 'ws:w3').dim, true, '无匹配的工作区变暗');
  }, '搜索强制显示命中项');

  check(() => {
    const statuses = new Map([
      ['session-b1', { pendingInteraction: { kind: 'approval' }, running: true }],
      ['session-b2', { running: false }],
      ['session-u1', { running: true }],
      ['session-u2', { running: false }],
    ]);
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [{ id: 'g1', title: '组一', sessionIds: ['session-b1'] }],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(),
      showGroups: true,
      focusActive: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
      statuses,
    });
    const keys = graph.nodes.map((node) => node.key).sort();
    assert.deepEqual(keys, ['sess:session-b1', 'sess:session-u1', 'ws:w1', 'ws:w2'], '聚焦：只留待处理/运行中会话 + 工作区祖先链');
    assert.ok(!keys.includes('grp:g1'), '聚焦时分组节点隐藏');
    assert.equal(graph.nodes.find((node) => node.key === 'ws:w1').parentKey, '', '根工作区没有父');
    assert.equal(graph.nodes.find((node) => node.key === 'ws:w2').parentKey, 'ws:w1', '子工作区挂在祖先链上');
    assert.deepEqual(
      graph.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`).sort(),
      ['member:ws:w1->sess:session-b1', 'member:ws:w2->sess:session-u1', 'nest:ws:w1->ws:w2'],
      '聚焦：只画链上的连线',
    );
    assert.equal(graph.stats.workspaces, 2);
    assert.equal(graph.stats.sessions, 2, '聚焦统计只数待关注会话');
    assert.equal(graph.stats.visibleSessions, 2);
    assert.equal(graph.stats.groups, 0, '聚焦时分组统计归零');
    assert.deepEqual(graph.stats.states, { pending: 1, running: 1, done: 0 });
    assert.equal(graph.stats.focused, true);
    const w1 = graph.nodes.find((node) => node.key === 'ws:w1');
    assert.equal(w1.counts.sessions, 1, '聚焦工作区只数待关注会话');
    assert.deepEqual(w1.states, { pending: 1, running: 0, done: 0 });
  }, '聚焦模式：待处理/运行中会话 + 工作区祖先链');

  check(() => {
    const statuses = new Map([
      ['session-b1', { running: false }],
      ['session-b2', { completionUnread: true }],
      ['session-u1', { running: false }],
      ['session-u2', { completionUnread: true }],
    ]);
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [{ id: 'g1', title: '组一', sessionIds: ['session-b2'] }],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(),
      showGroups: true,
      focusActive: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
      statuses,
    });
    const keys = graph.nodes.map((node) => node.key).sort();
    assert.deepEqual(keys, ['sess:session-b2', 'sess:session-u2', 'unassigned', 'ws:w1'], '聚焦：未读完成也进注意力视图，并带出工作区祖先链');
    assert.ok(!keys.includes('sess:session-b1'), '空闲会话仍然不进聚焦');
    assert.ok(!keys.includes('grp:g1'), '聚焦时分组仍隐藏');
    assert.equal(graph.nodes.find((node) => node.key === 'ws:w1').parentKey, '', '根工作区没有父');
    assert.equal(graph.nodes.find((node) => node.key === 'sess:session-b2').parentKey, 'ws:w1', '未读完成会话挂在所属工作区');
    assert.deepEqual(
      graph.edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`).sort(),
      ['member:ws:w1->sess:session-b2', 'unassigned:unassigned->sess:session-u2'],
      '聚焦：未读完成的连线照画',
    );
    assert.equal(graph.stats.workspaces, 1);
    assert.equal(graph.stats.sessions, 2, '聚焦统计把未读完成也算进来');
    assert.equal(graph.stats.visibleSessions, 2);
    assert.equal(graph.stats.groups, 0);
    assert.deepEqual(graph.stats.states, { pending: 0, running: 0, done: 2 });
    assert.equal(graph.nodes.find((node) => node.key === 'ws:w1').counts.sessions, 1, '工作区只数可见的未读完成会话');
    assert.deepEqual(graph.nodes.find((node) => node.key === 'ws:w1').states, { pending: 0, running: 0, done: 1 });
    assert.deepEqual(graph.nodes.find((node) => node.key === 'unassigned').states, { pending: 0, running: 0, done: 1 });
    const b2 = graph.nodes.find((node) => node.key === 'sess:session-b2');
    assert.equal(b2.state, 'done', '会话节点保留未读完成状态');
  }, '聚焦模式：未读完成会话也显示');

  check(() => {
    const build = (statuses) =>
      H.buildGraph({
        workspaces: graphWorkspaces,
        groups: [],
        list: graphSessions,
        options: graphOptions,
        expanded: new Set(),
        showGroups: true,
        focusActive: true,
        query: '',
        groupFallbackTitle: '组',
        unassignedTitle: '未归入',
        statuses,
      });
    const graph = build(new Map([['session-u2', { running: true }]]));
    const keys = graph.nodes.map((node) => node.key).sort();
    assert.deepEqual(keys, ['sess:session-u2', 'unassigned'], '聚焦：未归入的运行中会话自动出现');
    assert.equal(graph.stats.unassigned, 1);
    assert.equal(graph.nodes.find((node) => node.key === 'unassigned').counts.sessions, 1);
    const empty = build(new Map());
    assert.deepEqual(empty.nodes, [], '没有进行中会话时图应为空');
    assert.deepEqual(empty.edges, []);
    assert.equal(empty.stats.visibleSessions, 0);
    assert.deepEqual(empty.stats.states, { pending: 0, running: 0, done: 0 });
  }, '聚焦模式：未归入会话与空态');

  check(() => {
    const graph = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(['ws:w1']),
      showGroups: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    });
    const nodes = graph.nodes;
    const placed = H.placeNodes(nodes, {});
    const ws = placed['ws:w1'];
    const child = placed['ws:w2'];
    assert.ok(ws !== undefined && child !== undefined);
    assert.ok(child.x > ws.x, '子工作区在父右侧');
    // 子树排版：父节点居中在自己的子块上，子节点不再全部对齐到列顶。
    const b1 = placed['sess:session-b1'];
    const b2 = placed['sess:session-b2'];
    assert.ok(b1 !== undefined && b2 !== undefined);
    assert.ok(b1.y >= ws.y - 120 && b1.y <= ws.y + 120, `会话要贴着所属工作区排：ws=${ws.y} b1=${b1.y}`);
    const forkNode = nodes.find((node) => node.key === 'sess:session-b2');
    const parentNode = nodes.find((node) => node.key === 'sess:session-b1');
    assert.equal(forkNode.parentKey, 'sess:session-b1', 'fork 在排版上挂在父会话下');
    assert.ok(forkNode.layer > parentNode.layer, 'fork 子会话在更右一列');
    assert.ok(Math.abs(b2.y - b1.y) <= 80, '单个 fork 子与父会话对齐');
    assert.ok(Math.abs(child.y - ws.y) < 200, '子工作区也在父节点附近');
    // 每个节点都有自己的 parentKey，且父一定在更左列（group 除外，测试里没有分组）。
    for (const node of nodes) {
      if (node.parentKey === '') continue;
      const parent = nodes.find((item) => item.key === node.parentKey);
      assert.ok(parent !== undefined, `${node.key} 的父节点必须在图里`);
      assert.ok(parent.layer < node.layer, `${node.key} 的父节点应在更左列`);
    }
    const manual = H.placeNodes(nodes, { 'ws:w1': { x: 1234, y: 567 } });
    assert.equal(manual['ws:w1'].x, 1234);
    assert.equal(manual['ws:w1'].y, 567);
    assert.ok(manual['ws:w2'].y >= 0, '未手动的节点仍自动排');
    const layerYs = nodes
      .filter((node) => node.layer === 1)
      .map((node) => placed[node.key].y);
    assert.deepEqual(layerYs.slice().sort((left, right) => left - right), layerYs.slice().sort((left, right) => left - right));
    assert.equal(new Set(layerYs).size, layerYs.length, '同层不重叠');
  }, '布局：子树聚类/手动覆盖/不重叠');

  check(() => {
    // 回归：带子树的子节点必须按整棵子树占的高度往后排，否则兄弟会压到孙节点上
    // （真实数据里 DSH 插件 / 游戏 两个含子工作区的节点就是这样被叠住的）。
    const nodes = [
      { key: 'ws:a', kind: 'ws', layer: 0, rank: 0, ownerIndex: 0, itemIndex: 0, parentKey: '' },
      { key: 'ws:b', kind: 'ws', layer: 1, rank: 0, ownerIndex: 1, itemIndex: 0, parentKey: 'ws:a' },
      { key: 'ws:c', kind: 'ws', layer: 1, rank: 0, ownerIndex: 2, itemIndex: 0, parentKey: 'ws:a' },
      { key: 'sess:b1', kind: 'sess', layer: 2, rank: 1, ownerIndex: 1, itemIndex: 0, parentKey: 'ws:b' },
      { key: 'sess:b2', kind: 'sess', layer: 2, rank: 1, ownerIndex: 1, itemIndex: 1, parentKey: 'ws:b' },
      { key: 'sess:b3', kind: 'sess', layer: 2, rank: 1, ownerIndex: 1, itemIndex: 2, parentKey: 'ws:b' },
    ];
    const placed = H.placeNodes(nodes, {});
    const entries = Object.entries(placed);
    const clashes = [];
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (H.rectsOverlap(entries[i][1], entries[j][1], 0)) clashes.push(`${entries[i][0]} × ${entries[j][0]}`);
      }
    }
    assert.deepEqual(clashes, [], '嵌套子树的兄弟节点不能重叠');
    assert.ok(placed['ws:c'].y > placed['sess:b3'].y, '兄弟工作区要排在整棵子树下面');
  }, '布局：子树高度撑开兄弟节点（工作区重叠回归）');

  check(() => {
    const nodes = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(['ws:w1']),
      showGroups: false,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    }).nodes;
    const auto = H.placeNodes(nodes, {});
    const anchor = auto['ws:w1'];
    // 把 w2 拖到 w1 身上：显示时 w2 要被挪到最近的空位，w1 保持原位。
    const dropped = H.placeNodes(nodes, { 'ws:w2': { x: anchor.x + 20, y: anchor.y + 20 } });
    assert.ok(
      dropped['ws:w2'].x !== anchor.x + 20 || dropped['ws:w2'].y !== anchor.y + 20,
      '压在别人身上的手动位置要挪开',
    );
    const keys = Object.keys(dropped);
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        assert.equal(H.rectsOverlap(dropped[keys[i]], dropped[keys[j]], 0), false, `${keys[i]} 与 ${keys[j]} 重叠`);
      }
    }
    assert.equal(dropped['ws:w1'].x, anchor.x, '没手动过的节点保持自动位置');
    assert.equal(dropped['ws:w1'].y, anchor.y);
    // 手动拖走的父节点，子树要整棵跟着走（否则展开后会话落回旧列）。
    const moved = H.placeNodes(nodes, { 'ws:w1': { x: anchor.x + 2000, y: anchor.y } });
    for (const key of H.collectSubtreeKeys(nodes, 'ws:w1')) {
      if (key === 'ws:w1') continue;
      const before = { x: auto[key].x - anchor.x, y: auto[key].y - anchor.y };
      const after = { x: moved[key].x - moved['ws:w1'].x, y: moved[key].y - moved['ws:w1'].y };
      assert.ok(Math.abs(before.x - after.x) <= 0.001 && Math.abs(before.y - after.y) <= 0.001, `${key} 没跟着父节点走`);
    }
  }, '布局：手动位置避让 + 子树跟着父节点走');

  check(() => {
    const size = { w: 800, h: 600 };
    // 收起（或布局没变化）：容器在屏幕上原地不动，缩放不变。
    const rect = { x: 500, y: 900, w: 280, h: 96 };
    const still = H.followViewport({ x: 120, y: 90 }, rect, [rect], size, 0.8);
    assert.equal(still.zoom, 0.8, '跟随不改缩放');
    assert.equal(still.x, 120 - rect.x * 0.8);
    assert.equal(still.y, 90 - rect.y * 0.8);
    // 展开：子树底部超出视野 → 只做最小上移，把它露出来。
    const parent = { x: 100, y: 100, w: 280, h: 96 };
    const child = { x: 500, y: 400, w: 230, h: 56 };
    const panned = H.followViewport({ x: 100, y: 520 }, parent, [parent, child], size, 1);
    assert.equal(panned.zoom, 1);
    assert.ok((child.y + child.h) + panned.y <= size.h - 32 + 0.001, '子树底部要进视野');
    assert.ok((parent.y + panned.y) >= 0, '容器不能被推出视野');
    // 比视口还大：不做整体平移，容器保持锚点原位（不能为露全把卡片推出屏幕）。
    const tail = { x: 100, y: 1600, w: 280, h: 96 };
    const tall = H.followViewport({ x: 100, y: 0 }, parent, [parent, tail], size, 1);
    assert.equal(tall.x, 100 - parent.x, '高子树时 x 只做锚点补偿');
    assert.equal(tall.y, 0 - parent.y, '高子树时 y 只做锚点补偿');
    // 尺寸还没量到：只做锚点补偿，不炸。
    const cold = H.followViewport({ x: 10, y: 20 }, rect, [rect], { w: 0, h: 0 }, 1);
    assert.equal(cold.x, 10 - rect.x);
    assert.equal(cold.y, 20 - rect.y);
  }, '展开/收起视口跟随（锚点 / 最小平移 / 不改缩放）');

  check(() => {
    const byId = graphSessions.byId;
    assert.deepEqual(H.planOneClick([], byId, graphWorkspaces), { mode: 'none' });
    assert.deepEqual(H.planOneClick(['session-b1', 'session-b2'], byId, graphWorkspaces), {
      mode: 'adopt',
      dir: 'D:\\QAQ',
      workspaceId: 'w1',
      title: 'QAQ',
    });
    assert.deepEqual(H.planOneClick(['session-u2'], byId, graphWorkspaces), {
      mode: 'create',
      dir: 'C:\\other',
      title: 'other',
    });
    assert.deepEqual(H.planOneClick(['session-b1', 'session-u1'], byId, graphWorkspaces), { mode: 'dialog' }, '目录不同时应退回对话框');
  }, '一键建/归入工作区的计划');

  check(() => {
    const nodes = H.buildGraph({
      workspaces: graphWorkspaces,
      groups: [],
      list: graphSessions,
      options: graphOptions,
      expanded: new Set(['ws:w1']),
      showGroups: true,
      query: '',
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    }).nodes;
    const subtree = H.collectSubtreeKeys(nodes, 'ws:w1');
    assert.ok(subtree.includes('ws:w1'));
    assert.ok(subtree.includes('sess:session-b1'), '工作区子树含它的会话');
    assert.ok(subtree.includes('sess:session-b2'), '含 fork 孙会话');
    assert.ok(subtree.includes('ws:w2'), '含子工作区');
    assert.ok(!subtree.includes('unassigned'), '不串到别的根');
    assert.deepEqual(H.collectSubtreeKeys(nodes, 'sess:session-b1').sort(), ['sess:session-b1', 'sess:session-b2']);
  }, '拖拽/聚焦用的子树收集');

  check(() => {
    const pinned = new Set(['session-old-pinned']);
    const sessions = [
      { id: 'session-a', updatedAt: 3000 },
      { id: 'session-b', updatedAt: 5000 },
      { id: 'session-old-pinned', updatedAt: 1000 },
    ];
    const sorted = sessions
      .slice()
      .sort((left, right) => H.compareSessionsForDisplay(left, right, pinned))
      .map((item) => item.id);
    assert.deepEqual(sorted, ['session-old-pinned', 'session-b', 'session-a'], '置顶最上，其余按最近时间倒序');
    const tie = [
      { id: 'session-y', updatedAt: 7 },
      { id: 'session-z', updatedAt: 7 },
    ];
    assert.deepEqual(
      tie.slice().sort((left, right) => H.compareSessionsForDisplay(left, right, new Set())).map((item) => item.id),
      ['session-y', 'session-z'],
      '同一时间按 id 稳定',
    );
    assert.equal(H.compareSessionsForDisplay({ id: 'session-a' }, { id: 'session-b' }, new Set()) < 0, true, '缺时间按 0 处理');
  }, '会话展示排序：置顶优先 + 时间倒序');

  check(() => {
    const byId = { 'session-a': { updatedAt: 100 }, 'session-b': { updatedAt: 300 } };
    assert.equal(H.latestActivity(['session-a', 'session-b'], byId), 300);
    assert.equal(H.latestActivity([], byId), 0);
    assert.equal(H.latestActivity(['missing'], byId), 0);
    const local = new Date(2026, 10, 5, 22, 30).getTime();
    assert.equal(H.formatAbsoluteTime(local), '2026-11-05 22:30');
    assert.equal(H.formatAbsoluteTime('nope'), '');
    assert.equal(H.formatAbsoluteTime(undefined), '');
  }, '最近活动时间与绝对时间格式');

  check(() => {
    const workspace = { workspaceId: 'w1', path: 'D:\\QAQ', title: 'QAQ', sessionIds: [] };
    const byId = {};
    const ids = [];
    const add = (id, updatedAt) => {
      ids.push(id);
      byId[id] = { id, title: id, cwd: 'D:\\QAQ', updatedAt };
      workspace.sessionIds.push(id);
    };
    add('session-a', 1000);
    add('session-b', 3000);
    add('session-pinned', 500);
    const graph = H.buildGraph({
      workspaces: [workspace],
      groups: [],
      list: { ids, byId, phase: 'ready' },
      options: { showArchived: false, showSubagent: false, archivedIds: new Set() },
      expanded: new Set(['ws:w1']),
      showGroups: true,
      query: '',
      pinnedIds: new Set(['session-pinned']),
      groupFallbackTitle: '组',
      unassignedTitle: '未归入',
    });
    const order = graph.nodes
      .filter((node) => node.kind === 'sess')
      .sort((left, right) => left.itemIndex - right.itemIndex)
      .map((node) => node.id);
    assert.deepEqual(order, ['session-pinned', 'session-b', 'session-a'], '置顶在前、其余按最近时间倒序');
    assert.equal(graph.nodes.find((node) => node.key === 'sess:session-b').updatedAt, 3000);
    assert.equal(graph.nodes.find((node) => node.key === 'ws:w1').updatedAt, 3000, '工作区节点带最近活动时间');
  }, '节点图排序：置顶 + 最近时间');

  check(() => {
    const from = { x: 0, y: 0, w: 100, h: 40 };
    const to = { x: 300, y: 100, w: 100, h: 40 };
    const path = H.edgePath(from, to, 0);
    assert.match(path, /^M 100 20 C /);
    assert.ok(path.endsWith('300 120'), `终点应落在目标左边缘：${path}`);
    const paths = H.buildEdgePaths(
      [
        { from: 'a', to: 'b', kind: 'member' },
        { from: 'a', to: 'c', kind: 'member' },
        { from: 'x', to: 'y', kind: 'group' },
      ],
      { a: from, b: to, c: { x: 300, y: 200, w: 100, h: 40 }, x: from, y: to },
    );
    assert.equal(paths.length, 3);
    assert.ok(paths[0].d !== paths[1].d, '同源多条线要错位');
    assert.ok(paths.every((item) => typeof item.kind === 'string'));
  }, '连线 path 生成');

  check(() => {
    assert.equal(H.clampZoom(999), 1.8);
    assert.equal(H.clampZoom(0), 0.2);
    assert.equal(H.clampZoom('x'), 1);
    const viewport = { x: 40, y: 60, zoom: 1.5 };
    const world = { x: 100, y: 200 };
    const screen = H.worldToScreen(world, viewport);
    assert.deepEqual(H.screenToWorld(screen, viewport), world);
    const placed = { a: { x: 0, y: 0, w: 100, h: 40 }, b: { x: 400, y: 300, w: 100, h: 40 } };
    const fit = H.fitViewport(placed, { w: 800, h: 600 });
    assert.ok(fit.zoom > 0.2 && fit.zoom <= 1.8);
    assert.ok(Number.isFinite(fit.x) && Number.isFinite(fit.y));
    const visible = H.anyNodeVisible(placed, { x: 0, y: 0, zoom: 1 }, { w: 800, h: 600 });
    assert.equal(visible, true);
    assert.equal(H.anyNodeVisible({ far: { x: 5000, y: 5000, w: 100, h: 40 } }, { x: 0, y: 0, zoom: 1 }, { w: 800, h: 600 }), false, '漂到空白区要能识别');
    assert.equal(H.anyNodeVisible({}, { x: 0, y: 0, zoom: 1 }, { w: 800, h: 600 }), false);
    assert.equal(H.anyNodeVisible({ far: { x: 300, y: 300, w: 100, h: 40 } }, { x: -50, y: -50, zoom: 0.2 }, { w: 800, h: 600 }), true);
    assert.equal(H.anyNodeVisible(placed, null, { w: 800, h: 600 }), false, '没有视口时返回 false');
    const bounds = H.worldBounds(placed);
    assert.deepEqual(bounds, { minX: 0, minY: 0, width: 500, height: 340 });
  }, '视口与包围盒');

  check(() => {
    const layout = H.normalizeLayout({
      nodes: {
        'ws:w1': { x: 10, y: 20, expanded: true },
        'sess:session-b1': { x: -30, y: 40 },
        'grp:g1': { x: 999999, y: 1 },
        'grp:g2': { expanded: false },
        bad: { x: 1, y: 2 },
        'ws:': { x: 1, y: 2 },
        'ws:w2': { x: 'nope', y: 2 },
        'ws:w3': { x: 1, y: 2, expanded: 'yes' },
        'ws:w4': {},
      },
    });
    assert.deepEqual(Object.keys(layout.nodes).sort(), ['grp:g1', 'grp:g2', 'sess:session-b1', 'ws:w1', 'ws:w2', 'ws:w3']);
    assert.equal(layout.nodes['ws:w1'].expanded, true);
    assert.equal(layout.nodes['ws:w3'].expanded, undefined, '非布尔 expanded 丢弃');
    assert.equal(layout.nodes['grp:g1'].x, 100000, '坐标夹到上限');
    assert.equal(layout.nodes['sess:session-b1'].x, -30);
    assert.equal(layout.nodes['ws:w2'].x, undefined, '坏 x 丢弃但保留好 y');
    assert.equal(layout.nodes['ws:w2'].y, 2);
    assert.deepEqual(layout.nodes['grp:g2'], { expanded: false }, '只有展开态的条目必须保留');
    assert.equal(layout.nodes['ws:w4'], undefined, '全空的条目丢弃');
    assert.deepEqual(H.normalizeLayout(null), { nodes: {} });
  }, '布局规范化（坏键/坏值/上限/只记展开态）');

  check(() => {
    // 展开/收起都要发「跟随」请求；旧实现只在展开时把整棵子树缩放适配。
    const source = readFileSync(path.join(root, 'client.js'), 'utf8');
    assert.ok(!source.includes('focusRequest'), '旧的 focusRequest 应已移除');
    assert.ok(source.includes('followRequest'), '应有 followRequest 状态');
    assert.ok(source.includes('followViewport('), '跟随应走 followViewport 纯函数');
    const start = source.indexOf('function toggleExpanded(');
    assert.ok(start > 0, '应能定位 toggleExpanded');
    const block = source.slice(start, start + 1600);
    assert.ok(block.includes('setFollowRequest({'), '展开和收起都要发跟随请求');
    assert.ok(block.includes('worldToScreen('), '锚点必须记录操作前容器在屏幕上的位置');
    assert.ok(!/if \(expanding\) setFollowRequest/.test(block), '不能在收起时漏掉跟随');
  }, '展开/收起跟随：接线检查');

  check(() => {
    // 用户反馈：快速双击会把缩放条的「−」选中，之后拖动视图像失灵。
    const source = readFileSync(path.join(root, 'client.js'), 'utf8');
    assert.ok(/\.wg2-canvas\{[^}]*user-select:none/.test(source), '画布必须整块禁选');
    const zoom = source.indexOf("className: 'wg2-zoom'");
    assert.ok(zoom > 0, '应能定位缩放条');
    const block = source.slice(zoom, zoom + 700);
    assert.ok(block.includes('onMouseDown'), '缩放条按下要 preventDefault，避免选字/抢焦点');
    assert.ok(block.includes('preventDefault'), '缩放条按下要 preventDefault');
    assert.ok(source.includes('function isPanOrigin'), '平移起点判定要单独实现');
    assert.ok(source.includes("target.closest('.wg2-node, .wg2-zoom, button"), '节点/按钮/缩放条上不能起手平移');
    assert.ok(source.includes('removeAllRanges'), '开始平移前要清掉残留选区');
    assert.ok(!source.includes('event.target !== event.currentTarget'), '不能再用 target===currentTarget 判断平移');
  }, '拖动画布：禁选 / 缩放条不吃双击 / 平移起点判定');

  // -------------------------------------------------------------- Host 半边

  const Host = await import(pathToFileURL(path.join(root, 'index.js')).href);

  check(() => {
    assert.equal(Host.LIMITS.maxGroups, 200);
    assert.equal(Host.LIMITS.maxBodyBytes, 256 * 1024);
    assert.equal(Host.LIMITS.maxLayoutNodes, 2000);
    assert.equal(Host.ROUTE_STATE, '/workspace-graph/state');
    assert.equal(Host.ROUTE_GROUPS, '/workspace-graph/groups');
    assert.equal(Host.ROUTE_LAYOUT, '/workspace-graph/layout');
    assert.equal(Host.ROUTE_CREATE, '/workspace-graph/create-workspace');
    assert.equal(Host.ROUTE_ATTACH, '/workspace-graph/attach');
    assert.equal(Host.ROUTE_DETACH, '/workspace-graph/detach');
    assert.equal(Host.groupsFile(), process.env.DSH_WORKSPACE_GRAPH_FILE);
    assert.equal(typeof Host.normalizeLayout, 'function');
    assert.equal(typeof Host.readState, 'function');
    assert.equal(typeof Host.updateState, 'function');
  }, 'Host 常量与分组文件位置（env 覆盖）');

  check(() => {
    assert.equal(Host.classifyAttachError(new Error('cannot attach session x: its stored header carries no cwd to validate against')), 'no-cwd');
    assert.equal(Host.classifyAttachError(new Error("cannot attach session x: its cwd 'D:\\x' does not resolve, so it cannot be validated")), 'cwd-unresolved');
    assert.equal(Host.classifyAttachError(new Error("cannot attach session x: its cwd resolves to 'C:\\other'")), 'cwd-mismatch');
    assert.equal(Host.classifyAttachError(new Error("cannot attach session x: its cwd 'D:\\x' is not a directory")), 'cwd-mismatch');
    assert.equal(Host.classifyAttachError(new Error("cannot validate session 'x': session persistence holds no such session")), 'not-found');
    assert.equal(Host.classifyAttachError(new Error('boom')), 'failed');
  }, '收编错误分类');

  check(() => {
    // 会话 id 兼容两种格式：带 session- 前缀的、以及裸 uuid（旧版本/特殊会话沿用）。
    const bare = '008ce1b1-3532-4c74-ab3b-c80922884565';
    assert.deepEqual(Host.normalizeSessionIds(['session-a1', 'bad id', 'session-a1', 7, bare]), ['session-a1', bare]);
    assert.deepEqual(Host.normalizeSessionIds(['bad id']), []);
    assert.deepEqual(Host.normalizeSessionIds(undefined), []);
    const groups = Host.normalizeGroupList([
      { id: 'g1', title: '  一  ', sessionIds: ['session-a1', 'bad id'] },
      { id: 'g1', sessionIds: [] },
      'x',
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].title, '一');
    assert.deepEqual(groups[0].sessionIds, ['session-a1']);
    assert.notEqual(groups[1].id, 'g1');
  }, 'Host 分组规范化');

  check(() => {
    const allowed = Host.mutationAllowed({ method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(allowed.ok, true);
    assert.equal(Host.mutationAllowed({ method: 'GET', headers: {} }).code, 'bad-method');
    assert.equal(Host.mutationAllowed({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }).code, 'denied-origin');
    assert.equal(
      Host.mutationAllowed({ method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: '127.0.0.1:3081' } }).code,
      'denied-origin',
    );
    assert.equal(
      Host.mutationAllowed({ method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3081', host: '127.0.0.1:3081' } }).ok,
      true,
      '同源 Origin 必须放行',
    );
    assert.equal(Host.mutationAllowed({ method: 'POST', headers: { 'content-type': 'text/plain' } }).code, 'bad-content-type');
  }, '写请求闸口（方法 / 同源 / JSON）');

  // 分组文件：缺失 → 空集；写入 → 读回一致；损坏 → 回落空集
  {
    const file = process.env.DSH_WORKSPACE_GRAPH_FILE;
    const empty = await Host.readGroups(file);
    assert.deepEqual(empty.groups, []);

    const written = await Host.writeGroups([{ id: 'g1', title: '一组', sessionIds: ['session-a1'] }], file);
    assert.equal(written.groups.length, 1);
    const readBack = await Host.readGroups(file);
    assert.deepEqual(readBack.groups, written.groups);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.ok(onDisk.layout !== null && typeof onDisk.layout === 'object', '状态文件带 layout 字段');
    assert.equal(onDisk.groups[0].title, '一组');

    await Promise.all([
      Host.writeGroups([{ id: 'g2', title: '并发 A', sessionIds: [] }], file),
      Host.writeGroups([{ id: 'g3', title: '并发 B', sessionIds: [] }], file),
      Host.writeGroups([{ id: 'g4', title: '并发 C', sessionIds: [] }], file),
    ]);
    const afterConcurrent = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(afterConcurrent.groups.length, 1, '并发写必须是整表替换，不能交错');
    const leftovers = existsSync(`${file}.tmp`);
    assert.equal(leftovers, false, '不应留下半成品临时文件');

    writeFileSync(file, '{ 坏掉的 json', 'utf8');
    const degraded = await Host.readGroups(file);
    assert.deepEqual(degraded.groups, []);

    checks += 1;
    console.log('PASS 分组文件（缺失/写读/并发/损坏回落）');
  }

  // -------------------------------------------------------------- 路由行为

  const entity = makeEntity('w1', 'D:\\QAQ\\bookkeeping', '记账');
  const registry = makeRegistry([entity]);
  const routesCtx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) };
  const routes = Host.buildRoutes(routesCtx);
  const routeOf = (routePath) => routes.find((route) => route.path === routePath);
  const jsonHeaders = { 'content-type': 'application/json' };

  check(() => {
    assert.equal(routes.length, 6);
    assert.deepEqual(
      routes.map((route) => route.path),
      [Host.ROUTE_STATE, Host.ROUTE_GROUPS, Host.ROUTE_LAYOUT, Host.ROUTE_CREATE, Host.ROUTE_ATTACH, Host.ROUTE_DETACH],
    );
  }, '路由表');

  {
    const state = await call(routeOf(Host.ROUTE_STATE), { method: 'GET' });
    assert.equal(state.status, 200);
    assert.equal(state.body.ok, true);
    assert.equal(state.body.version, 2);
    assert.ok(Array.isArray(state.body.groups));
    assert.ok(state.body.layout !== null && typeof state.body.layout === 'object');
    assert.ok(state.body.layout.nodes !== null && typeof state.body.layout.nodes === 'object');
    assert.equal(state.body.limits.maxGroups, 200);
    assert.equal(state.body.limits.maxLayoutNodes, 2000);

    const wrongMethod = await call(routeOf(Host.ROUTE_STATE), { method: 'POST', headers: jsonHeaders, json: {} });
    assert.equal(wrongMethod.status, 405);

    checks += 1;
    console.log('PASS GET /state（200 + layout / 错方法 405）');
  }

  {
    const saved = await call(routeOf(Host.ROUTE_GROUPS), {
      method: 'POST',
      headers: jsonHeaders,
      json: { version: 1, groups: [{ id: 'g1', title: '组 A', sessionIds: ['session-a1'] }] },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.groups.length, 1);
    assert.equal(saved.body.groups[0].title, '组 A');

    const readBack = await call(routeOf(Host.ROUTE_STATE), { method: 'GET' });
    assert.equal(readBack.body.groups.length, 1);

    const crossSite = await call(routeOf(Host.ROUTE_GROUPS), {
      method: 'POST',
      headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' },
      json: { groups: [] },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.code, 'denied-origin');

    const evilOrigin = await call(routeOf(Host.ROUTE_GROUPS), {
      method: 'POST',
      headers: { ...jsonHeaders, origin: 'http://evil.example', host: '127.0.0.1:3081' },
      json: { groups: [] },
    });
    assert.equal(evilOrigin.status, 403);

    const noType = await call(routeOf(Host.ROUTE_GROUPS), {
      method: 'POST',
      headers: {},
      json: { groups: [] },
    });
    assert.equal(noType.status, 415);

    const badJson = await call(routeOf(Host.ROUTE_GROUPS), {
      method: 'POST',
      headers: jsonHeaders,
      rawBody: '{ not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.code, 'bad-json');

    checks += 1;
    console.log('PASS POST /groups（保存 / 劫持拒绝 / 坏 JSON）');
  }

  {
    const saved = await call(routeOf(Host.ROUTE_LAYOUT), {
      method: 'POST',
      headers: jsonHeaders,
      json: { nodes: { 'ws:w1': { x: 12, y: 34, expanded: true }, 'sess:session-a1': { x: -5, y: 6 } } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.layout.nodes['ws:w1'].x, 12);
    assert.equal(saved.body.layout.nodes['ws:w1'].expanded, true);

    const readBack = await call(routeOf(Host.ROUTE_STATE), { method: 'GET' });
    assert.equal(readBack.body.layout.nodes['ws:w1'].y, 34);
    assert.equal(readBack.body.groups.length, 1, '写布局不能动分组');

    const groupsAfter = await call(routeOf(Host.ROUTE_GROUPS), {
      method: 'POST',
      headers: jsonHeaders,
      json: { groups: [{ id: 'g2', title: '组 B', sessionIds: [] }] },
    });
    assert.equal(groupsAfter.body.layout.nodes['ws:w1'].x, 12, '写分组不能动布局');

    const bad = await call(routeOf(Host.ROUTE_LAYOUT), {
      method: 'POST',
      headers: jsonHeaders,
      json: { nodes: { 'ws:w1': { x: 'nope', y: 1 }, bad: { x: 1, y: 2 }, 'grp:g9': { x: 999999, y: 0 } } },
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.layout.nodes['ws:w1'].x, undefined, '非法 x 丢弃、好 y 保留');
    assert.equal(bad.body.layout.nodes['ws:w1'].y, 1);
    assert.equal(bad.body.layout.nodes.bad, undefined, '非法键被丢弃');
    assert.equal(bad.body.layout.nodes['grp:g9'].x, 100000, '坐标夹取');

    // 「只记展开态」的条目必须能存活：展开/收起刷新后不能丢。
    const expandOnly = await call(routeOf(Host.ROUTE_LAYOUT), {
      method: 'POST',
      headers: jsonHeaders,
      json: { nodes: { 'ws:w9': { expanded: true }, 'grp:g9': { expanded: false } } },
    });
    assert.equal(expandOnly.status, 200);
    assert.deepEqual(expandOnly.body.layout.nodes['ws:w9'], { expanded: true });
    const expandBack = await call(routeOf(Host.ROUTE_STATE), { method: 'GET' });
    assert.deepEqual(expandBack.body.layout.nodes['ws:w9'], { expanded: true }, '只记展开态的条目要持久化');
    assert.deepEqual(expandBack.body.layout.nodes['grp:g9'], { expanded: false });

    const crossSite = await call(routeOf(Host.ROUTE_LAYOUT), {
      method: 'POST',
      headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' },
      json: { nodes: {} },
    });
    assert.equal(crossSite.status, 403);

    const wrongMethod = await call(routeOf(Host.ROUTE_LAYOUT), { method: 'GET' });
    assert.equal(wrongMethod.status, 405);

    checks += 1;
    console.log('PASS POST /layout（保存 / 分组布局互不覆盖 / 拒绝）');
  }

  {
    const v1File = path.join(tempRoot, 'v1-groups.json');
    writeFileSync(v1File, JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', groups: [{ id: 'old', title: '旧组', sessionIds: [] }] }), 'utf8');
    const v1 = await Host.readState(v1File);
    assert.equal(v1.groups.length, 1);
    assert.deepEqual(v1.layout, { nodes: {} }, 'v1 文件没有 layout 时补空');
  }


  {
    const result = await call(routeOf(Host.ROUTE_CREATE), {
      method: 'POST',
      headers: jsonHeaders,
      json: { path: 'D:\\QAQ\\bookkeeping', title: '记账', adoptSessionIds: ['session-b1', 'session-bad', 'session-ghost'] },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.created, false, '同目录已存在时应复用');
    assert.equal(result.body.title, '记账');
    assert.deepEqual(result.body.adopted, ['session-b1']);
    assert.deepEqual(
      result.body.skipped.map((item) => [item.sessionId, item.status]),
      [
        ['session-bad', 'cwd-mismatch'],
        ['session-ghost', 'not-found'],
      ],
    );

    const created = await call(routeOf(Host.ROUTE_CREATE), {
      method: 'POST',
      headers: jsonHeaders,
      json: { path: 'D:\\QAQ\\fresh', title: '新项目', adoptSessionIds: [] },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.created, true);
    assert.equal(created.body.titleApplied, true);
    assert.equal(created.body.title, '新项目');

    const missing = await call(routeOf(Host.ROUTE_CREATE), {
      method: 'POST',
      headers: jsonHeaders,
      json: { path: 'D:\\QAQ\\missing' },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'create-failed');

    const noPath = await call(routeOf(Host.ROUTE_CREATE), { method: 'POST', headers: jsonHeaders, json: {} });
    assert.equal(noPath.status, 400);
    assert.equal(noPath.body.code, 'path-required');

    checks += 1;
    console.log('PASS POST /create-workspace（复用 + 收编分类 + 新建 + 失败）');
  }

  {
    const attached = await call(routeOf(Host.ROUTE_ATTACH), {
      method: 'POST',
      headers: jsonHeaders,
      json: { workspaceId: 'w1', sessionIds: ['session-b1', 'session-bad'] },
    });
    assert.equal(attached.status, 200);
    assert.deepEqual(
      attached.body.results.map((item) => [item.sessionId, item.status]),
      [
        ['session-b1', 'already'],
        ['session-bad', 'cwd-mismatch'],
      ],
    );

    const detached = await call(routeOf(Host.ROUTE_DETACH), {
      method: 'POST',
      headers: jsonHeaders,
      json: { workspaceId: 'w1', sessionIds: ['session-b1', 'session-other'] },
    });
    assert.equal(detached.status, 200);
    assert.deepEqual(
      detached.body.results.map((item) => [item.sessionId, item.status]),
      [
        ['session-b1', 'detached'],
        ['session-other', 'absent'],
      ],
    );

    const unknownWorkspace = await call(routeOf(Host.ROUTE_ATTACH), {
      method: 'POST',
      headers: jsonHeaders,
      json: { workspaceId: 'nope', sessionIds: ['session-b1'] },
    });
    assert.equal(unknownWorkspace.status, 404);
    assert.equal(unknownWorkspace.body.code, 'workspace-not-found');

    const emptySessions = await call(routeOf(Host.ROUTE_ATTACH), {
      method: 'POST',
      headers: jsonHeaders,
      json: { workspaceId: 'w1', sessionIds: [] },
    });
    assert.equal(emptySessions.status, 400);

    checks += 1;
    console.log('PASS POST /attach|/detach（幂等 / 分类 / 404 / 空参数）');
  }

  {
    const noRegistry = Host.buildRoutes({ get: () => undefined });
    const result = await call(noRegistry.find((route) => route.path === Host.ROUTE_CREATE), {
      method: 'POST',
      headers: jsonHeaders,
      json: { path: 'D:\\QAQ\\bookkeeping' },
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'registry-unavailable');
  }

  check(() => {
    const registered = [];
    const injected = [];
    const webServer = { register: (route) => { registered.push(route); return () => {}; } };
    Host.apply(
      {
        get: (name) => (name === 'webServer' ? webServer : undefined),
        inject: (deps, callback) => {
          injected.push(deps);
          callback({ get: (name) => (name === 'webServer' ? webServer : undefined), effect: (fn) => fn() });
          return () => {};
        },
        logger: { info() {}, warn() {} },
        effect: (callback) => callback(),
      },
      {},
    );
    assert.deepEqual(injected, [['webServer']], 'apply 必须通过 ctx.inject 等 webServer');
    assert.equal(registered.length, 6);
    assert.ok(registered.some((route) => route.path === Host.ROUTE_LAYOUT));
    assert.ok(registered.every((route) => route.kind === 'exact'));
    assert.ok(registered.every((route) => typeof route.handler === 'function'));
  }, 'Host apply 在 webServer 就绪后注册 6 条路由');

  check(() => {
    let registered = 0;
    let pending = null;
    Host.apply(
      {
        get: () => undefined,
        inject: (_deps, callback) => {
          pending = callback; // 模拟「插件行早于 webServer」：此刻不回调
          return () => {};
        },
        logger: { info() {}, warn() {} },
        effect: (callback) => callback(),
      },
      {},
    );
    assert.equal(registered, 0);
    assert.equal(typeof pending, 'function', '应把回调交给 ctx.inject 等依赖');
    pending({
      get: (name) => (name === 'webServer' ? { register: () => { registered += 1; return () => {}; } } : undefined),
      effect: (fn) => fn(),
    });
    assert.equal(registered, 6, '依赖就绪后才注册');
  }, 'Host apply 不早于 webServer 注册（启动时序回归）');

  check(() => {
    let warned = 0;
    let pending = null;
    Host.apply(
      {
        get: () => undefined,
        inject: (_deps, callback) => {
          pending = callback;
          return () => {};
        },
        logger: { info() {}, warn() { warned += 1; } },
        effect: (callback) => callback(),
      },
      {},
    );
    pending({ get: () => undefined, effect: (fn) => fn() });
    assert.equal(warned, 1, '服务名已声明却取不到时应 warn 并降级');
  }, 'Host apply 依赖不可用时降级');

  check(() => {
    const registered = [];
    let logged = 0;
    Host.apply(
      {
        // 老宿主：没有 ctx.inject，只能直接抓
        get: (name) => (name === 'webServer' ? { register: (route) => { registered.push(route); return () => {}; } } : undefined),
        logger: { info() { logged += 1; }, warn() {} },
        effect: (callback) => callback(),
      },
      {},
    );
    assert.equal(registered.length, 6);
    assert.equal(logged, 1);
  }, 'Host apply 老宿主兜底（无 ctx.inject）');

  check(() => {
    let logged = 0;
    Host.apply({ get: () => undefined, logger: { info() { logged += 1; }, warn() {} }, effect: (callback) => callback() }, {});
    assert.equal(logged, 1, '没有 webServer 且没有 ctx.inject 时只记一条日志并降级');
  }, 'Host 无 webServer 时降级');

  // -------------------------------------------------------------- 静态约束

  const clientSource = readFileSync(path.join(root, 'client.js'), 'utf8');
  const hostSource = readFileSync(path.join(root, 'index.js'), 'utf8');

  check(() => {
    assert.ok(sourceHas(clientSource, 'window.__ModuleLoader__.load'), '缺少模块加载器入口');
    assert.ok(!/@deepseek-ai\/dsh-/.test(clientSource), 'client.js 不得 import Harness 包');
    assert.ok(!/dangerouslySetInnerHTML/.test(clientSource), '不得使用 dangerouslySetInnerHTML');
    assert.ok(!/document\.body/.test(clientSource), '不得改写 document.body');
    assert.ok(!/innerHTML/.test(clientSource), '不得写 innerHTML');
    const hexes = [...clientSource.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toLowerCase());
    const literals = new Set(hexes);
    assert.ok([...literals].every((value) => value === '#fff'), `不应出现字面色值：${Array.from(literals).join(',')}`);
    assert.ok((clientSource.match(/--dsw-alias-/g) ?? []).length >= 20, '样式应主要使用主题 token');
  }, '客户端静态约束（无 Harness 包 / 无 innerHTML / token 化）');

  /**
   * 简单的字符串包含断言（写在这里只为让上面一行更好读）。
   * @param {string} haystack - 源码。
   * @param {string} needle - 片段。
   * @returns {boolean} 是否包含。
   */
  function sourceHas(haystack, needle) {
    return haystack.includes(needle);
  }

  check(() => {
    assert.ok(hostSource.includes("ctx.inject(['webServer']"), 'Host 半边必须等 webServer 就绪（启动时序）');
    assert.ok(!/apply[\s\S]{0,400}ctx\.get\?\.\('webServer'\)/.test(hostSource), 'apply 不得直接抢先抓 webServer');
    assert.ok(hostSource.includes('/workspace-graph/state'));
    assert.ok(hostSource.includes('attachSession'), '收编必须走工作区实体的 attachSession');
    assert.ok(!/^import .*@deepseek-ai/m.test(hostSource), 'Host 半边不应依赖第三方包');
    assert.ok(!/workspace\.json/.test(hostSource), '不得直接碰 DSH 的 workspace 存储');
  }, 'Host 半边静态约束');

  check(() => {
    assert.ok(sourceHas(clientSource, 'revealWorkspaceInSidebar'), '打开工作区应尝试定位侧栏');
    assert.ok(sourceHas(clientSource, 'data-row-key'), '定位侧栏分组行依赖 data-row-key');
    assert.ok(sourceHas(clientSource, 'setGroupExpanded'), '定位应通过视图写集展开分组');
    assert.ok(sourceHas(clientSource, 'workspaceAncestorIdsOf'), '树形分组下应先展开被折叠的祖先分组');
    assert.ok(sourceHas(clientSource, 'aria-expanded'), '展开祖先前应以 aria-expanded 判断是否折叠');
    assert.ok(sourceHas(clientSource, 'scrollWorkspaceRowIntoView'), '定位应把行滚到面板偏上位置');
    assert.ok(sourceHas(clientSource, 'scrollTo'), '偏上定位应显式设置滚动容器的 scrollTop');
    assert.ok(sourceHas(clientSource, 'scrollIntoView'), '定位应有原生 scrollIntoView 兜底');
  }, '打开工作区后定位侧栏分组（展开祖先 + 滚到偏上）');

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const zhMeta = JSON.parse(readFileSync(path.join(root, 'locale/zh.json'), 'utf8'));
  const enMeta = JSON.parse(readFileSync(path.join(root, 'locale/en.json'), 'utf8'));
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  const icon = readFileSync(path.join(root, 'icon.svg'), 'utf8');

  check(() => {
    assert.equal(pkg.name, 'dsh-session-atlas');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.equal(pkg.dsh.client.immediately, true);
    assert.equal(typeof pkg.exports['.'], 'string');
    assert.equal(pkg.exports['./client'], './client.js');
    assert.ok(pkg.exports['./icon'] !== undefined);
    assert.ok(pkg.files.includes('client.js'));
    assert.ok(pkg.files.includes('index.js'));
    assert.ok(pkg.files.includes('locale/*.json'));
    assert.ok(patch.includes('id: dsh-session-atlas'));
    assert.ok(patch.includes('name: dsh-session-atlas'));
    assert.equal(zhMeta.meta.title, '工作区图');
    assert.ok(zhMeta.meta.description.length > 10);
    assert.ok(typeof enMeta.meta.title === 'string' && enMeta.meta.title.length > 0);
    assert.ok(typeof enMeta.meta.description === 'string' && enMeta.meta.description.length > 10);
  }, '清单 / 文案 / patch 一致');

  check(() => {
    // 所有静态文案键都必须在 zh 词典里存在（动态键如 `reason.${status}` 由正则排除）。
    const used = new Set([...clientSource.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]));
    const missing = [...used].filter((key) => H.DICT.zh[key] === undefined);
    assert.deepEqual(missing, [], `缺少文案：${missing.join(', ')}`);
    const enMissing = [...used].filter((key) => H.DICT.en[key] === undefined);
    assert.deepEqual(enMissing, [], `英文缺文案：${enMissing.join(', ')}`);
    assert.ok(used.size >= 60, `静态文案键数量异常：${used.size}`);
  }, '文案键完整性');

  check(() => {
    assert.ok(icon.trim().startsWith('<svg'), 'icon.svg 必须是 SVG');
    assert.ok(icon.includes('</svg>'));
    assert.ok(Buffer.byteLength(icon, 'utf8') < 256 * 1024);
    assert.ok(existsSync(path.join(root, 'README.md')), '缺少 README.md');
  }, '图标与 README 存在');

  console.log('');
  console.log(`ALL CHECKS PASSED (${checks})`);
} catch (error) {
  console.error('');
  console.error(`FAIL after ${checks} passing checks`);
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结果 */
  }
}
