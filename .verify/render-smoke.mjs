/**
 * 交互冒烟：用带 hooks/effects 的迷你 React 在 Node 里跑「点开工作区箭头」这条真实路径。
 *
 * 解决什么问题：verify.mjs 的静态渲染测试不执行 useEffect，曾漏掉「展开聚焦 effect 里
 * 引用未声明变量（minX is not defined）」这种只在点击后才炸的 bug。这里会真跑 effect、
 * 真的调用一次箭头的 onClick，并断言展开后会话节点出现、渲染没有抛错。
 *
 * 用法：node tools/render-smoke.mjs（成功打印 SMOKE OK；失败退出码 1）
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

globalThis.__WORKSPACE_GRAPH_TEST__ = {};
const localStorageSeed = new Map([
  // dsh_tishi 的隐藏工作区契约：默认不画这个工作区。
  ['dsh-tishi.hiddenWorkspaces.v1', JSON.stringify({ v: 1, ids: ['w-old'] })],
]);
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__capturedDefinition = definition;
    },
  },
  localStorage: {
    getItem: (key) => (localStorageSeed.has(key) ? localStorageSeed.get(key) : null),
    setItem: (key, value) => {
      localStorageSeed.set(key, String(value));
    },
    removeItem: (key) => {
      localStorageSeed.delete(key);
    },
  },
};
globalThis.document = { addEventListener() {}, removeEventListener() {} };
// 面板里有一个每分钟刷新相对时间的 setInterval；冒烟不需要它，也不能让它挂住进程。
globalThis.setInterval = () => 0;
// 画布尺寸走 resize 分支（Node 里没有 ResizeObserver，也不会监听 window）。
globalThis.ResizeObserver = undefined;

const hooks = [];
let hookIndex = 0;
let dirty = false;
let pendingEffects = [];
const effectMeta = [];

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    const index = hookIndex += 1;
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      const next = typeof value === 'function' ? value(hooks[index]) : value;
      if (next !== hooks[index]) {
        hooks[index] = next;
        dirty = true;
      }
    };
    return [hooks[index], set];
  },
  useRef(initial) {
    const index = hookIndex += 1;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  },
  useEffect(fn, deps) {
    const index = hookIndex += 1;
    const previous = effectMeta[index];
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((item, i) => item !== previous.deps[i]);
    effectMeta[index] = { deps: deps ?? [] };
    if (changed) pendingEffects.push(fn);
  },
  Component: class {
    constructor(props) {
      this.props = props ?? {};
      this.state = {};
    }

    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
      dirty = true;
    }
  },
};

const ids = ['session-11111111-1111-4111-8111-111111111111', 'session-22222222-2222-4222-8222-222222222222', 'session-33333333-3333-4333-8333-333333333333'];
const workspaces = [
  { workspaceId: 'w1', path: 'D:\\QAQ', title: 'QAQ', sessionIds: [...ids] },
  { workspaceId: 'w-old', path: 'D:\\QAQ\\old', title: '旧项目', sessionIds: [] },
];
const byId = Object.fromEntries(
  ids.map((id, index) => [id, { id, title: `会话 ${index}`, cwd: 'D:\\QAQ', updatedAt: Date.now() - index * 60000 }]),
);
const snapshot = { items: workspaces, archivedSessionIds: [], pinnedSessionIds: [ids[1]], state: 'idle', phase: 'ready', error: null };
const list = { ids, byId, phase: 'ready', projectionsBySession: {} };
const stateBody = { ok: true, version: 2, groups: [], layout: { nodes: {} }, limits: {} };
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(stateBody) });

const pluginModule = await import(pathToFileURL(path.join(root, 'client.js')).href);
void pluginModule;
const plugin = globalThis.__capturedDefinition.factory(() => React);
const registrations = [];
plugin.apply({
  locale: { register: () => () => {}, bind: () => (key) => key, subscribe: () => () => {} },
  slots: {
    inject: (_name, callback) => callback(),
    register: (_options, component) => {
      registrations.push(component);
      return () => {};
    },
  },
  effect: (callback) => callback(),
  get: () => undefined,
});
const Panel = globalThis.__WORKSPACE_GRAPH_TEST__?.renderPanel;
if (typeof Panel !== 'function') {
  console.error('SMOKE FAIL: 拿不到 renderPanel 测试钩子');
  process.exit(1);
}

const statuses = new Map([
  [ids[0], { pendingInteraction: { kind: 'approval' } }],
  [ids[1], { running: true }],
  [ids[2], { completionUnread: true }],
]);
const props = { useWorkspaces: () => snapshot, useSessions: () => list, useSessionStatus: () => statuses };
const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node.props === undefined) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

// 画布元素：挂到 canvasRef 上，让 size / 视口跟随这些 effect 真正跑起来。
const CANVAS_SIZE = { w: 1600, h: 900 };
const makeCanvas = () => ({
  clientWidth: CANVAS_SIZE.w,
  clientHeight: CANVAS_SIZE.h,
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
});
const attachCanvas = (tree) => {
  walk(tree, (node) => {
    const ref = node.props?.ref;
    if (ref !== null && typeof ref === 'object' && 'current' in ref && ref.current === null) ref.current = makeCanvas();
  });
};

let renderCount = 0;
async function runLoop() {
  let tree;
  let guard = 0;
  do {
    dirty = false;
    hookIndex = 0;
    pendingEffects = [];
    tree = Panel(props);
    renderCount += 1;
    attachCanvas(tree);
    for (const effect of pendingEffects) {
      effect();
    }
    // 让 fetch / setState 的微任务落地后再决定是否重渲染。
    await new Promise((resolve) => setTimeout(resolve, 0));
    guard += 1;
    if (guard > 40) throw new Error('渲染循环没有收敛');
  } while (dirty);
  return tree;
}

/** 渲染树里的视口 transform（`translate(xpx, ypx) scale(z)`）。 */
const viewportOf = (root) => {
  let transform = null;
  walk(root, (node) => {
    if (transform !== null) return;
    const value = node.props?.style?.transform;
    if (typeof value === 'string' && /^translate\([-\d.]+px, [-\d.]+px\) scale\([-\d.]+\)$/.test(value)) transform = value;
  });
  const match = transform === null ? null : /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform);
  return match === null ? null : { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
};

/** 节点在世界坐标里的左上角。 */
const nodeRectOf = (root, key) => {
  let found = null;
  walk(root, (node) => {
    if (found !== null) return;
    if (node.props?.key === key && typeof node.props?.className === 'string' && node.props.className.includes('wg2-node')) {
      found = { x: node.props.style?.left, y: node.props.style?.top };
    }
  });
  return found;
};

/** 节点在屏幕上的左上角 + 当前缩放。 */
const screenOf = (root, key) => {
  const viewport = viewportOf(root);
  const rect = nodeRectOf(root, key);
  if (viewport === null || rect === null) return null;
  return { x: rect.x * viewport.zoom + viewport.x, y: rect.y * viewport.zoom + viewport.y, zoom: viewport.zoom };
};

const near = (left, right) => Math.abs(left - right) <= 0.5;

/** 世界坐标里所有节点矩形的并集包围盒。 */
const nodeRectsOf = (root) => {
  const rects = [];
  walk(root, (node) => {
    if (node.type !== 'div' || typeof node.props?.className !== 'string') return;
    if (!node.props.className.split(/\s+/).includes('wg2-node')) return;
    const style = node.props.style ?? {};
    const values = [style.left, style.top, style.width, style.height];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return;
    rects.push({ x: style.left, y: style.top, w: style.width, h: style.height });
  });
  return rects;
};

/** 断言所有节点整体被缩放并居中（fitViewport 的几何结果）。 */
const centeredProblems = (root, label) => {
  const issues = [];
  const viewport = viewportOf(root);
  const rects = nodeRectsOf(root);
  if (viewport === null || rects.length === 0) return [`${label}: 拿不到视口或节点`];
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  const width = maxX - minX;
  const height = maxY - minY;
  const left = minX * viewport.zoom + viewport.x;
  const top = minY * viewport.zoom + viewport.y;
  const right = maxX * viewport.zoom + viewport.x;
  const bottom = maxY * viewport.zoom + viewport.y;
  const expectedLeft = (CANVAS_SIZE.w - width * viewport.zoom) / 2;
  const expectedTop = (CANVAS_SIZE.h - height * viewport.zoom) / 2;
  if (Math.abs(left - expectedLeft) > 1) issues.push(`${label}: 水平未居中 left=${left.toFixed(1)} 期望 ${expectedLeft.toFixed(1)}`);
  if (Math.abs(top - expectedTop) > 1) issues.push(`${label}: 垂直未居中 top=${top.toFixed(1)} 期望 ${expectedTop.toFixed(1)}`);
  if (left < -1 || top < -1 || right > CANVAS_SIZE.w + 1 || bottom > CANVAS_SIZE.h + 1) {
    issues.push(`${label}: 结果超出画布 (${left.toFixed(1)}, ${top.toFixed(1)}) - (${right.toFixed(1)}, ${bottom.toFixed(1)})`);
  }
  return issues;
};

const problems = [];
let tree;
try {
  tree = await runLoop();
} catch (error) {
  problems.push(`初次渲染失败: ${error?.stack ?? error}`);
}
const WS_KEY = `ws:${workspaces[0].workspaceId}`;
const findChevron = (root) => {
  let found = null;
  walk(root, (node) => {
    if (found === null && node.props?.className === 'wg2-chev') found = node;
  });
  return found;
};
const countSessionNodes = (root) => {
  let count = 0;
  walk(root, (node) => {
    if (node.type !== 'div' || typeof node.props?.className !== 'string') return;
    if (node.props.className.split(/\s+/).includes('wg2-node-sess')) count += 1;
  });
  return count;
};
/** 指定工作区节点的个数（0 或 1）。 */
const countWorkspaceNodes = (root, key) => {
  let count = 0;
  walk(root, (node) => {
    if (node.type !== 'div' || node.props?.key !== key) return;
    if (typeof node.props.className === 'string' && node.props.className.includes('wg2-node')) count += 1;
  });
  return count;
};
/** 「显示已隐藏」开关（aria-label 带当前隐藏数量）。 */
const findHiddenToggle = (root) => {
  let found = null;
  walk(root, (node) => {
    if (found !== null) return;
    if (node.type === 'input' && node.props?.['aria-label'] === '显示已隐藏 (1)') found = node;
  });
  return found;
};
let chevron = findChevron(tree);
if (tree !== null && tree !== undefined) {
  const collapsedDump = JSON.stringify(tree);
  if (!collapsedDump.includes('wg2-state-pending')) problems.push('折叠态工作区应显示待处理状态角标');
  if (!collapsedDump.includes('wg2-state-running')) problems.push('折叠态工作区应显示运行中状态角标');
  if (!collapsedDump.includes('wg2-state-done')) problems.push('折叠态工作区应显示未读完成状态角标');
  if (!collapsedDump.includes('wg2-totals')) problems.push('顶部应显示全局状态汇总');
}
if (chevron === null) {
  problems.push('找不到工作区展开箭头（wg2-chev）');
} else {
  const before = JSON.stringify(tree);
  const screenBefore = screenOf(tree, WS_KEY);
  if (screenBefore === null) problems.push('拿不到工作区展开前的屏幕位置');
  try {
    chevron.props.onClick({ stopPropagation() {} });
    tree = await runLoop();
  } catch (error) {
    problems.push(`点击展开后渲染失败: ${error?.stack ?? error}`);
  }
  const after = JSON.stringify(tree ?? null);
  if (after === before) problems.push('点击展开后界面没有任何变化');
  if (!after.includes('待处理')) problems.push('展开后待处理会话应显示待处理徽标');
  if (!after.includes('运行中')) problems.push('展开后运行中会话应显示运行中徽标');
  if (!after.includes('未读完成')) problems.push('展开后未读完成会话应显示未读完成徽标');
  const sessionNodes = countSessionNodes(tree);
  if (sessionNodes !== ids.length) problems.push(`展开后会话节点应为 ${ids.length} 个，实际 ${sessionNodes} 个`);
  const screenExpanded = screenOf(tree, WS_KEY);
  if (screenBefore !== null && screenExpanded !== null) {
    if (!near(screenExpanded.x, screenBefore.x) || !near(screenExpanded.y, screenBefore.y)) {
      problems.push(`展开后工作区应原地不动：${JSON.stringify(screenBefore)} → ${JSON.stringify(screenExpanded)}`);
    }
    if (!near(screenExpanded.zoom, screenBefore.zoom)) {
      problems.push(`展开跟随不应改变缩放：${screenBefore.zoom} → ${screenExpanded.zoom}`);
    }
  } else {
    problems.push('拿不到展开后工作区的屏幕位置');
  }
  // 再点一次收起：跟随 effect 也要跑通，会话节点必须消失、工作区仍原地不动。
  chevron = findChevron(tree);
  if (chevron === null) {
    problems.push('展开后找不到收起箭头');
  } else {
    const screenBeforeCollapse = screenOf(tree, WS_KEY);
    try {
      chevron.props.onClick({ stopPropagation() {} });
      tree = await runLoop();
    } catch (error) {
      problems.push(`点击收起后渲染失败: ${error?.stack ?? error}`);
    }
    if (countSessionNodes(tree) !== 0) problems.push('收起后会话节点应全部消失');
    const screenCollapsed = screenOf(tree, WS_KEY);
    if (screenBeforeCollapse !== null && screenCollapsed !== null) {
      if (!near(screenCollapsed.x, screenBeforeCollapse.x) || !near(screenCollapsed.y, screenBeforeCollapse.y)) {
        problems.push(`收起后工作区应原地不动：${JSON.stringify(screenBeforeCollapse)} → ${JSON.stringify(screenCollapsed)}`);
      }
    } else {
      problems.push('拿不到收起后工作区的屏幕位置');
    }
  }
}

// 拖动画布：即使页面上有残留选区（双击「−」那种）也要能平移，并且开始平移时清掉选区。
const findFocusToggle = (root) => {
  let found = null;
  walk(root, (node) => {
    if (found !== null) return;
    const label = node.props?.['aria-label'];
    if (node.type === 'input' && (label === '只看进行中与未读完成' || label === '只看进行中' || label === 'toolbar.focusActive')) found = node;
  });
  return found;
};
const findSearchInput = (root) => {
  let found = null;
  walk(root, (node) => {
    if (found !== null) return;
    if (node.type !== 'input' || typeof node.props?.className !== 'string') return;
    if (node.props.className.split(/\s+/).includes('wg2-search')) found = node;
  });
  return found;
};
const focusToggle = findFocusToggle(tree);
if (focusToggle === null) {
  problems.push('找不到「只看进行中」开关');
} else {
  if (countSessionNodes(tree) !== 0) problems.push('折叠时不应有会话节点');
  const viewportBeforeFocus = viewportOf(tree);
  try {
    focusToggle.props.onChange({ target: { checked: true } });
    tree = await runLoop();
  } catch (error) {
    problems.push(`打开聚焦后渲染失败: ${error?.stack ?? error}`);
  }
  const focusedSessions = countSessionNodes(tree);
  if (focusedSessions !== ids.length) problems.push(`聚焦后应直接显示 ${ids.length} 个进行中会话，实际 ${focusedSessions} 个`);
  const viewportFocused = viewportOf(tree);
  if (
    viewportBeforeFocus !== null &&
    viewportFocused !== null &&
    near(viewportFocused.x, viewportBeforeFocus.x) &&
    near(viewportFocused.y, viewportBeforeFocus.y) &&
    near(viewportFocused.zoom, viewportBeforeFocus.zoom)
  ) {
    problems.push('打开聚焦后视口应自动缩放并居中到筛选结果');
  }
  for (const issue of centeredProblems(tree, '打开聚焦后')) problems.push(issue);
  const toggleOff = findFocusToggle(tree);
  if (toggleOff === null) {
    problems.push('聚焦开启后找不到关闭开关');
  } else {
    try {
      toggleOff.props.onChange({ target: { checked: false } });
      tree = await runLoop();
    } catch (error) {
      problems.push(`关闭聚焦后渲染失败: ${error?.stack ?? error}`);
    }
    if (countSessionNodes(tree) !== 0) problems.push('关闭聚焦后应回到折叠态（没有会话节点）');
    for (const issue of centeredProblems(tree, '关闭聚焦后')) problems.push(issue);
  }
}

// 搜索也是筛选：命中结果必须自动缩放/居中，清空后回到折叠态。
const searchInput = findSearchInput(tree);
if (searchInput === null) {
  problems.push('找不到搜索框');
} else {
  try {
    searchInput.props.onChange({ target: { value: '会话 1' } });
    tree = await runLoop();
  } catch (error) {
    problems.push(`搜索后渲染失败: ${error?.stack ?? error}`);
  }
  const hits = countSessionNodes(tree);
  if (hits !== 1) problems.push(`搜索「会话 1」应只显示 1 个会话，实际 ${hits} 个`);
  for (const issue of centeredProblems(tree, '搜索结果')) problems.push(issue);
  const clearInput = findSearchInput(tree);
  if (clearInput === null) {
    problems.push('清空搜索前找不到搜索框');
  } else {
    try {
      clearInput.props.onChange({ target: { value: '' } });
      tree = await runLoop();
    } catch (error) {
      problems.push(`清空搜索后渲染失败: ${error?.stack ?? error}`);
    }
    if (countSessionNodes(tree) !== 0) problems.push('清空搜索后应回到折叠态（没有会话节点）');
  }
}

// 拖动画布：即使页面上有残留选区（双击「−」那种）也要能平移，并且开始平移时清掉选区。
const canvasElement = (() => {
  let found = null;
  walk(tree, (node) => {
    const ref = node.props?.ref;
    if (found === null && ref !== null && typeof ref === 'object' && 'current' in ref && ref.current !== null) {
      found = { props: node.props, element: ref.current, ref };
    }
  });
  return found;
})();
if (canvasElement === null) {
  problems.push('找不到画布元素');
} else {
  const viewportBefore = viewportOf(tree);
  const selection = {
    rangeCount: 1,
    cleared: false,
    removeAllRanges() {
      this.cleared = true;
    },
  };
  const originalGetSelection = globalThis.window.getSelection;
  globalThis.window.getSelection = () => selection;
  const press = (pointerTarget, fromX, fromY, toX, toY) => {
    canvasElement.props.onPointerDown({
      button: 0,
      target: pointerTarget,
      currentTarget: canvasElement.element,
      clientX: fromX,
      clientY: fromY,
      pointerId: 1,
      stopPropagation() {},
    });
    canvasElement.props.onPointerMove({ clientX: toX, clientY: toY });
    canvasElement.props.onPointerUp({});
  };
  try {
    // 从「非控件的子元素」起手（target 不是画布本身）也必须能平移。
    press({ closest: () => null }, 100, 100, 160, 140);
    tree = await runLoop();
    // 从按钮/节点之类控件起手不能平移（事件冒泡到画布也一样）。
    press({ closest: () => ({}) }, 300, 300, 400, 360);
    tree = await runLoop();
  } catch (error) {
    problems.push(`拖动平移失败: ${error?.stack ?? error}`);
  } finally {
    globalThis.window.getSelection = originalGetSelection;
  }
  const viewportAfter = viewportOf(tree);
  if (!selection.cleared) problems.push('开始平移时应清掉残留选区');
  if (viewportBefore === null || viewportAfter === null) {
    problems.push('拿不到平移前后的视口');
  } else if (!near(viewportAfter.x, viewportBefore.x + 60) || !near(viewportAfter.y, viewportBefore.y + 40)) {
    problems.push(`拖动 60×40 应平移视口：${JSON.stringify(viewportBefore)} → ${JSON.stringify(viewportAfter)}`);
  }
}

// 侧栏隐藏的工作区：默认不画，勾「显示已隐藏」后放出，并带徽标与虚线样式。
const HIDDEN_WS_KEY = 'ws:w-old';
if (countWorkspaceNodes(tree, HIDDEN_WS_KEY) !== 0) problems.push('默认不应画被 dsh_tishi 隐藏的工作区');
const hiddenToggle = findHiddenToggle(tree);
if (hiddenToggle === null) {
  problems.push('找不到「显示已隐藏」开关');
} else {
  try {
    hiddenToggle.props.onChange({ target: { checked: true } });
    tree = await runLoop();
  } catch (error) {
    problems.push(`放出隐藏工作区失败: ${error?.stack ?? error}`);
  }
  if (countWorkspaceNodes(tree, HIDDEN_WS_KEY) !== 1) problems.push('勾选「显示已隐藏」后应画出一个隐藏工作区');
  const hiddenDump = JSON.stringify(tree);
  if (!hiddenDump.includes('is-hidden-ws')) problems.push('放出的隐藏工作区应带虚线样式 is-hidden-ws');
  if (!hiddenDump.includes('已隐藏')) problems.push('放出的隐藏工作区应带「已隐藏」徽标');
  const toggleBack = findHiddenToggle(tree);
  if (toggleBack === null) {
    problems.push('放出后找不到「显示已隐藏」开关');
  } else {
    try {
      toggleBack.props.onChange({ target: { checked: false } });
      tree = await runLoop();
    } catch (error) {
      problems.push(`重新隐藏失败: ${error?.stack ?? error}`);
    }
    if (countWorkspaceNodes(tree, HIDDEN_WS_KEY) !== 0) problems.push('取消勾选后应重新隐藏');
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error('SMOKE FAIL:', problem);
  process.exit(1);
}
console.log(`SMOKE OK renders=${renderCount}`);
