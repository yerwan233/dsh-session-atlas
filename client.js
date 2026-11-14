/**
 * dsh-session-atlas —— 浏览器半边（侧栏「工作区图」页面）。
 *
 * 页面把两件事放进同一张图：
 *   ① 真实工作区（DSH 原生）：节点 = 工作区目录，成员 = 该目录里创建的会话；
 *      可以新建 / 改名 / 删除登记、在成员上「解挂」，未归入的同目录会话可以「收编」。
 *   ② 分组（本插件自有）：纯会话集合，可跨工作区；多选会话建组、组合并、删组；
 *      全组同目录时可一键「固化」成真实工作区（建目录工作区 + 收编）。
 *
 * 为什么分成两层：会话头里的 cwd 不可变，DSH 只允许「同目录会话」进入同名工作区，
 * 没有跨目录搬会话的接口。所以真实工作区保持原语义，跨目录的整理需求放在分组里，
 * 不伪造 DSH 数据，也不让界面说谎。
 *
 * 约定：
 *   - 只 require('react')，不引任何 Harness Client 包；
 *   - 颜色只用 --dsw-alias-* token；分支缩进用 glyph + 间距，不写 DOM；
 *   - 数据：真实工作区 / 会话来自 main 槽位标准 props 的 selector hooks（实时）；
 *     分组来自 Host 路由，写操作整表提交，响应即事实来源。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-atlas',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------- 常量

    const PANEL_ID = 'workspace-graph';
    const NS = 'workspaceGraph';
    const PANEL_ORDER = 120;
    const SIDEBAR_SLOT = 'sidebar.panellist';
    const MAIN_SLOT = 'main';

    const ROUTES = {
      state: '/workspace-graph/state',
      groups: '/workspace-graph/groups',
      layout: '/workspace-graph/layout',
      create: '/workspace-graph/create-workspace',
      attach: '/workspace-graph/attach',
      detach: '/workspace-graph/detach',
    };

    const LIMITS = { maxGroups: 200, maxSessionsPerGroup: 2000, maxTitleLength: 60, maxLayoutNodes: 2000, maxCoord: 100000 };
    // 只校验字符与长度；存在性由 Host 判断，不在这里猜 id 格式。
    // 兼容两种会话 id：带 `session-` 前缀的（主流）与裸 uuid 的（旧版本/特殊会话沿用裸 id）。
    const SESSION_ID = /^(?:session-)?[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
    const LS_UI = 'dsh-session-atlas.v1.ui';
    const LS_VIEWPORT = 'dsh-session-atlas.v2.viewport';
    // dsh_tishi 的隐藏工作区集合（只读契约，不写回）：{v:1,ids:[...]}，旧版为裸数组。
    const TISHI_HIDDEN_KEY = 'dsh-tishi.hiddenWorkspaces.v1';
    // 「打开工作区」后等侧栏重渲染出分组行的时长上限（毫秒）；只影响定位，不影响打开本身。
    const SIDEBAR_REVEAL_MS = 3000;

    // 节点图几何常量（纯像素；缩放由 viewport 统一处理，节点自身不随缩放改尺寸）。
    const NODE_SIZE = {
      ws: { w: 280, h: 96 },
      grp: { w: 260, h: 88 },
      sess: { w: 230, h: 56 },
      unassigned: { w: 240, h: 76 },
    };
    const COLUMN_PITCH_EXTRA = 120;
    const ROW_GAP = 20;
    const GROUP_GAP = 80;
    const LAYOUT_MARGIN = 80;
    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 1.8;
    const MAX_LAYER = 12;
    const LAYOUT_KEY = /^(?:(?:ws|grp|sess):[A-Za-z0-9_-]{1,80}|unassigned)$/;

    // -------------------------------------------------------------- 小工具

    /**
     * 会话 / 工作区目录的粗比较键：统一分隔符、去尾部分隔符、小写。
     * 只用于界面提示与「共同目录」推断；权威判定在 Host（realpath），不要拿它当结论。
     * @param {unknown} path - 目录字符串。
     * @returns {string} 比较键。
     */
    function canonicalKey(path) {
      if (typeof path !== 'string') return '';
      return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    /**
     * 路径最后一段，作为默认标题。
     * @param {unknown} path - 目录字符串。
     * @returns {string} 末段。
     */
    function basenameOf(path) {
      const text = typeof path === 'string' ? path.trim().replace(/[\\/]+$/, '') : '';
      if (text === '') return '';
      const parts = text.split(/[\\/]/);
      return parts[parts.length - 1] || text;
    }

    /**
     * 裁剪并去空白；标题类字段统一走这里。
     * @param {unknown} value - 原始值。
     * @param {number} max - 上限。
     * @returns {string} 结果。
     */
    function clampText(value, max) {
      const text = typeof value === 'string' ? value.trim() : '';
      return text.slice(0, max);
    }

    /**
     * 会话显示名：手动标题 > 投影标题 > id。
     * @param {object} summary - SessionSummary。
     * @returns {string} 显示名。
     */
    function summaryTitle(summary) {
      if (summary === null || summary === undefined) return '';
      if (typeof summary.title === 'string' && summary.title.trim() !== '') return summary.title.trim();
      if (typeof summary.displayTitle === 'string' && summary.displayTitle.trim() !== '') return summary.displayTitle.trim();
      return typeof summary.id === 'string' ? summary.id : '';
    }

    /**
     * 造一个分组 id。
     * @param {string} prefix - 前缀。
     * @returns {string} id。
     */
    function uid(prefix) {
      const cryptoApi = typeof globalThis === 'object' ? globalThis.crypto : undefined;
      if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;
      const random = Math.random().toString(16).slice(2, 10);
      return `${prefix}-${Date.now().toString(16)}-${random}`;
    }

    /**
     * 把时间戳拆成「相对时间」结构，交给界面按语言渲染。
     * @param {unknown} value - 毫秒时间戳或可解析字符串。
     * @param {Date} [now] - 时间源（测试注入）。
     * @returns {{kind: string, n?: number, time?: string, date?: string}|null} 结构。
     */
    function timeParts(value, now) {
      const stamp =
        typeof value === 'number' && Number.isFinite(value)
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Date.parse(value)
            : Number.NaN;
      if (!Number.isFinite(stamp)) return null;
      const current = now instanceof Date ? now : new Date();
      const diff = current.getTime() - stamp;
      if (diff < 60 * 1000) return { kind: 'justNow' };
      if (diff < 60 * 60 * 1000) return { kind: 'minutes', n: Math.max(1, Math.floor(diff / 60000)) };
      if (diff < 6 * 60 * 60 * 1000) return { kind: 'hours', n: Math.max(1, Math.floor(diff / 3600000)) };
      const date = new Date(stamp);
      const pad = (number) => String(number).padStart(2, '0');
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      const sameDay =
        date.getFullYear() === current.getFullYear() &&
        date.getMonth() === current.getMonth() &&
        date.getDate() === current.getDate();
      if (sameDay) return { kind: 'today', time: clock };
      const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
      const isYesterday =
        date.getFullYear() === yesterday.getFullYear() &&
        date.getMonth() === yesterday.getMonth() &&
        date.getDate() === yesterday.getDate();
      if (isYesterday) return { kind: 'yesterday', time: clock };
      return { kind: 'date', date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` };
    }

    /**
     * 绝对时间（悬停提示里用）。
     * @param {unknown} value - 毫秒时间戳或可解析字符串。
     * @returns {string} `YYYY-MM-DD HH:mm`，解析不了返回空串。
     */
    function formatAbsoluteTime(value) {
      const stamp =
        typeof value === 'number' && Number.isFinite(value)
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Date.parse(value)
            : Number.NaN;
      if (!Number.isFinite(stamp)) return '';
      const date = new Date(stamp);
      const pad = (number) => String(number).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * 会话展示排序：**置顶优先**，其次按「最近对话时间」倒序（新的在上），最后按 id 稳定排序。
     * @param {object} left - SessionSummary。
     * @param {object} right - SessionSummary。
     * @param {Set<string>} pinnedIds - 置顶会话集合。
     * @returns {number} 比较结果。
     */
    function compareSessionsForDisplay(left, right, pinnedIds) {
      const pinned = pinnedIds instanceof Set ? pinnedIds : new Set();
      const leftPinned = pinned.has(left?.id) ? 1 : 0;
      const rightPinned = pinned.has(right?.id) ? 1 : 0;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      const leftTime = typeof left?.updatedAt === 'number' && Number.isFinite(left.updatedAt) ? left.updatedAt : 0;
      const rightTime = typeof right?.updatedAt === 'number' && Number.isFinite(right.updatedAt) ? right.updatedAt : 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
    }

    /**
     * 一组会话里最近的对话时间（毫秒时间戳），没有返回 0。
     * @param {string[]} sessionIds - 会话 id。
     * @param {Record<string, object>} byId - 会话行。
     * @returns {number} 最近时间戳或 0。
     */
    function latestActivity(sessionIds, byId) {
      let latest = 0;
      for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
        const stamp = byId === null || byId === undefined ? undefined : byId[id]?.updatedAt;
        if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > latest) latest = stamp;
      }
      return latest;
    }

    /**
     * 会话是否按当前开关可见。
     * @param {object} summary - SessionSummary。
     * @param {{showArchived: boolean, showSubagent: boolean, archivedIds: Set<string>}} options - 开关。
     * @returns {boolean} 可见。
     */
    function visibleSummary(summary, options) {
      if (summary === null || summary === undefined) return false;
      if (options.archivedIds.has(summary.id) && options.showArchived !== true) return false;
      if (summary.origin === 'subagent' && options.showSubagent !== true) return false;
      return true;
    }

    // ---- 会话状态（判定与官方 sessionStatuses / dsh-tishi 一致）----

    /** 需要人工处理的交互类型；这些优先于「运行中」。 */
    const PENDING_KINDS = new Set(['approval', 'question', 'plan-review']);
    /** 待处理细分类型 → 文案键。 */
    const PENDING_LABEL_KEYS = { approval: 'status.approval', question: 'status.question', 'plan-review': 'status.planReview' };
    /** 状态展示顺序：待处理 → 运行中 → 未读完成。 */
    const STATE_ORDER = ['pending', 'running', 'done'];

    /**
     * 取一个会话的状态快照；`useSessionStatus` 的 Map 与普通对象都接受。
     * @param {Map<string, object>|Record<string, object>|null|undefined} statuses - 状态表。
     * @param {string} sessionId - 会话 id。
     * @returns {object|undefined} SessionStatus。
     */
    function statusOf(statuses, sessionId) {
      if (statuses === null || statuses === undefined) return undefined;
      if (typeof statuses.get === 'function') return statuses.get(sessionId);
      return typeof statuses === 'object' ? statuses[sessionId] : undefined;
    }

    /**
     * 会话等待中的交互类型（approval / question / plan-review），没有返回空串。
     * @param {object|undefined} status - SessionStatus。
     * @returns {string} 类型。
     */
    function pendingKindOf(status) {
      const pending = status !== null && typeof status === 'object' ? status.pendingInteraction : null;
      if (pending !== null && typeof pending === 'object' && PENDING_KINDS.has(pending.kind)) return pending.kind;
      return '';
    }

    /**
     * 会话主状态：pending > running > done > idle（与官方 sessionStatuses 优先级一致）。
     * status.running 缺失时回退 summary.running（旧宿主/缺状态时仍能显示运行中）。
     * @param {object|undefined} status - SessionStatus。
     * @param {object|undefined} summary - SessionSummary。
     * @returns {'pending'|'running'|'done'|'idle'} 状态。
     */
    function sessionState(status, summary) {
      if (pendingKindOf(status) !== '') return 'pending';
      let running = false;
      if (status !== null && typeof status === 'object' && status.running !== undefined) running = status.running === true;
      else running = summary !== null && summary !== undefined && summary.running === true;
      if (running) return 'running';
      if (status !== null && typeof status === 'object' && status.completionUnread === true) return 'done';
      return 'idle';
    }

    /**
     * 聚合一组会话的状态计数（工作区/分组/未归入节点用）。
     * 与 dsh-tishi 一致：归档会话与子智能体会话不计入（子代理始终不计）。
     * @param {string[]} sessionIds - 会话 id。
     * @param {Record<string, object>} byId - 会话行。
     * @param {Map<string, object>|Record<string, object>|null|undefined} statuses - 状态表。
     * @param {Set<string>} [archivedIds] - 归档会话集合。
     * @returns {{pending: number, running: number, done: number}} 计数。
     */
    function aggregateStates(sessionIds, byId, statuses, archivedIds) {
      const counts = { pending: 0, running: 0, done: 0 };
      const archived = archivedIds instanceof Set ? archivedIds : new Set();
      for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
        if (typeof sessionId !== 'string' || sessionId === '' || archived.has(sessionId)) continue;
        const summary = byId !== null && typeof byId === 'object' ? byId[sessionId] : undefined;
        if (summary === null || summary === undefined || typeof summary !== 'object') continue;
        if (summary.origin === 'subagent') continue;
        const state = sessionState(statusOf(statuses, sessionId), summary);
        if (state === 'pending' || state === 'running' || state === 'done') counts[state] += 1;
      }
      return counts;
    }

    /**
     * 节点左侧状态色条取哪个状态：会话看自身；容器取最高优先级（pending > running > done）。
     * @param {object} node - 图节点。
     * @returns {'pending'|'running'|'done'|''} 状态；空闲/未知返回空串。
     */
    function nodeAccentState(node) {
      if (node === null || typeof node !== 'object') return '';
      const state =
        node.kind === 'sess'
          ? node.state
          : STATE_ORDER.find(
              (key) =>
                node.states !== null &&
                typeof node.states === 'object' &&
                typeof node.states[key] === 'number' &&
                node.states[key] > 0,
            );
      return state === 'pending' || state === 'running' || state === 'done' ? state : '';
    }

    /**
     * 把一个工作区的成员排成「父 → 子」树行；父会话不在本工作区（或成环）时降级为顶层。
     * @param {string[]} memberIds - 按手动顺序的成员 id。
     * @param {Record<string, object>} byId - 会话行。
     * @param {number} [maxDepth] - 最大缩进层级，防止异常数据成环。
     * @returns {Array<{id: string, depth: number}>} 行。
     */
    function nestRows(memberIds, byId, maxDepth = 8) {
      const rows = [];
      // 成员表里可能有会话已经不存在（工作区记录比会话活得更久），先剔掉。
      const present = memberIds.filter((id) => byId[id] !== undefined);
      const memberSet = new Set(present);
      const childrenOf = new Map();
      for (const id of present) {
        const summary = byId[id];
        const parent = summary && typeof summary.parentId === 'string' ? summary.parentId : '';
        if (parent === '' || !memberSet.has(parent)) continue;
        const list = childrenOf.get(parent);
        if (list === undefined) childrenOf.set(parent, [id]);
        else list.push(id);
      }
      const visited = new Set();
      const walk = (id, depth) => {
        if (visited.has(id) || depth > maxDepth) return;
        visited.add(id);
        rows.push({ id, depth });
        const children = childrenOf.get(id);
        if (children === undefined) return;
        for (const child of children) walk(child, depth + 1);
      };
      for (const id of present) {
        const summary = byId[id];
        const parent = summary && typeof summary.parentId === 'string' ? summary.parentId : '';
        if (parent === '' || !memberSet.has(parent)) walk(id, 0);
      }
      for (const id of present) {
        if (visited.has(id)) continue;
        visited.add(id);
        rows.push({ id, depth: 0 });
      }
      return rows;
    }

    /**
     * 一个工作区的可见成员行。
     * @param {object} workspace - WorkspaceView。
     * @param {object} list - SessionListState。
     * @param {object} options - 可见性开关。
     * @returns {Array<{id: string, depth: number}>} 行。
     */
    function workspaceRows(workspace, list, options) {
      const byId = list && typeof list === 'object' ? list.byId ?? {} : {};
      const memberIds = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [];
      return nestRows(
        memberIds.filter((id) => visibleSummary(byId[id], options)),
        byId,
      );
    }

    /**
     * 没有归入任何工作区的会话，按最近更新倒序。
     * @param {object} list - SessionListState。
     * @param {object[]} workspaces - WorkspaceView 数组。
     * @param {object} options - 可见性开关。
     * @returns {object[]} 会话行。
     */
    function unassignedRows(list, workspaces, options) {
      const rows = [];
      if (list === null || typeof list !== 'object') return rows;
      const byId = list.byId ?? {};
      const ids = Array.isArray(list.ids) ? list.ids : Object.keys(byId);
      const accounted = new Set();
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) accounted.add(id);
      }
      for (const id of ids) {
        if (accounted.has(id)) continue;
        const summary = byId[id];
        if (!visibleSummary(summary, options)) continue;
        rows.push(summary);
      }
      rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      return rows;
    }

    /**
     * 按 cwd 找一个目录相同的工作区（界面提示用）。
     * @param {object} summary - SessionSummary。
     * @param {object[]} workspaces - WorkspaceView 数组。
     * @returns {object|null} 工作区或 null。
     */
    function suggestWorkspace(summary, workspaces) {
      const key = canonicalKey(summary?.cwd);
      if (key === '') return null;
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        if (canonicalKey(workspace?.path) === key) return workspace;
      }
      return null;
    }

    /**
     * 会话当前所属的工作区（分组页里显示归属用）。
     * @param {object} summary - SessionSummary。
     * @param {object[]} workspaces - WorkspaceView 数组。
     * @returns {object|null} 工作区或 null。
     */
    function workspaceOf(summary, workspaces) {
      if (summary === null || summary === undefined) return null;
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        if (Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(summary.id)) return workspace;
      }
      return null;
    }

    /**
     * 预演「哪些会话能收编进目标目录」：只比较目录字符串，真正结果以 Host 返回为准。
     * @param {string[]} sessionIds - 会话 id。
     * @param {Record<string, object>} byId - 会话行。
     * @param {string} targetPath - 目标目录。
     * @returns {{accepted: string[], rejected: Array<{id: string, reason: string}>}} 预演结果。
     */
    function partitionAdoptable(sessionIds, byId, targetPath) {
      const target = canonicalKey(targetPath);
      const accepted = [];
      const rejected = [];
      for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
        const summary = byId?.[id];
        if (summary === undefined) {
          rejected.push({ id, reason: 'not-found' });
          continue;
        }
        const cwd = typeof summary.cwd === 'string' ? summary.cwd.trim() : '';
        if (cwd === '') {
          rejected.push({ id, reason: 'no-cwd' });
          continue;
        }
        if (target !== '' && canonicalKey(cwd) === target) accepted.push(id);
        else rejected.push({ id, reason: 'cwd-mismatch' });
      }
      return { accepted, rejected };
    }

    /**
     * 一组会话的共同目录；有任何一个没有 cwd 或不一致就返回空串。
     * @param {string[]} sessionIds - 会话 id。
     * @param {Record<string, object>} byId - 会话行。
     * @returns {string} 共同目录或空串。
     */
    function commonDirectory(sessionIds, byId) {
      const keys = new Set();
      const display = new Map();
      for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
        const cwd = typeof byId?.[id]?.cwd === 'string' ? byId[id].cwd.trim() : '';
        if (cwd === '') return '';
        const key = canonicalKey(cwd);
        keys.add(key);
        if (!display.has(key)) display.set(key, cwd);
      }
      if (keys.size !== 1) return '';
      return display.get(Array.from(keys)[0]) ?? '';
    }

    /**
     * 「一键建/归入工作区」的计划：选中会话 → 决定是直接收编进已有工作区、直接新建，还是需要问目录。
     * 纯函数，便于离线测。
     * @param {string[]} sessionIds - 选中的会话。
     * @param {Record<string, object>} byId - 会话行。
     * @param {object[]} workspaces - WorkspaceView 数组。
     * @returns {{mode: 'none'|'dialog'|'adopt'|'create', dir?: string, title?: string, workspaceId?: string}} 计划。
     */
    function planOneClick(sessionIds, byId, workspaces) {
      const ids = Array.isArray(sessionIds) ? sessionIds : [];
      if (ids.length === 0) return { mode: 'none' };
      const dir = commonDirectory(ids, byId);
      if (dir === '') return { mode: 'dialog' };
      const owner = (Array.isArray(workspaces) ? workspaces : []).find(
        (workspace) => workspace !== null && typeof workspace === 'object' && canonicalKey(workspace.path) === canonicalKey(dir),
      );
      if (owner !== undefined) {
        return { mode: 'adopt', dir, workspaceId: owner.workspaceId, title: owner.title || basenameOf(owner.path) };
      }
      return { mode: 'create', dir, title: basenameOf(dir) };
    }

    /**
     * 从图节点里收集某节点及其全部后代键（拖容器/展开聚焦用）。
     * @param {object[]} nodes - 图节点（带 `parentKey`）。
     * @param {string} rootKey - 根键。
     * @returns {string[]} `[rootKey, ...后代键]`。
     */
    function collectSubtreeKeys(nodes, rootKey) {
      const childMap = new Map();
      for (const node of Array.isArray(nodes) ? nodes : []) {
        if (node === null || typeof node !== 'object' || typeof node.parentKey !== 'string' || node.parentKey === '') continue;
        const bucket = childMap.get(node.parentKey);
        if (bucket === undefined) childMap.set(node.parentKey, [node.key]);
        else bucket.push(node.key);
      }
      const keys = [];
      const stack = [rootKey];
      const seen = new Set();
      while (stack.length > 0) {
        const key = stack.pop();
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
        for (const child of childMap.get(key) ?? []) stack.push(child);
      }
      return keys;
    }

    // ---------------------------------------------------------------- 分组

    /** 当前 ISO 时间。 */
    function nowIso() {
      return new Date().toISOString();
    }

    /**
     * 规范化分组数组：丢非法条目、去重 id、裁标题、夹上限。读和写都走这里。
     * @param {unknown} raw - 原始数组或 `{groups}`。
     * @returns {object[]} 分组。
     */
    function normalizeGroups(raw) {
      const source = Array.isArray(raw)
        ? raw
        : raw !== null && typeof raw === 'object' && Array.isArray(raw.groups)
          ? raw.groups
          : [];
      const groups = [];
      const seen = new Set();
      for (const entry of source) {
        if (groups.length >= LIMITS.maxGroups) break;
        if (entry === null || typeof entry !== 'object') continue;
        let id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim().slice(0, 80) : '';
        if (id === '' || seen.has(id)) id = uid('grp');
        while (seen.has(id)) id = uid('grp');
        seen.add(id);
        const ids = [];
        const localSeen = new Set();
        for (const rawId of Array.isArray(entry.sessionIds) ? entry.sessionIds : []) {
          if (typeof rawId !== 'string' || !SESSION_ID.test(rawId) || localSeen.has(rawId)) continue;
          localSeen.add(rawId);
          ids.push(rawId);
          if (ids.length >= LIMITS.maxSessionsPerGroup) break;
        }
        const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : nowIso();
        groups.push({
          id,
          title: clampText(entry.title, LIMITS.maxTitleLength),
          sessionIds: ids,
          createdAt,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : createdAt,
        });
      }
      return groups;
    }

    /**
     * 建一个分组插到最前面。
     * @param {object[]} groups - 现有分组。
     * @param {string} title - 标题。
     * @param {string[]} sessionIds - 成员。
     * @returns {{groups: object[], group: object}} 新列表与新分组。
     */
    function addGroup(groups, title, sessionIds) {
      const seen = new Set();
      const ids = [];
      for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
        if (typeof id !== 'string' || !SESSION_ID.test(id) || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= LIMITS.maxSessionsPerGroup) break;
      }
      const stamp = nowIso();
      const group = {
        id: uid('grp'),
        title: clampText(title, LIMITS.maxTitleLength),
        sessionIds: ids,
        createdAt: stamp,
        updatedAt: stamp,
      };
      return { groups: [group, ...groups], group };
    }

    /**
     * 删除若干分组。
     * @param {object[]} groups - 现有分组。
     * @param {string[]} ids - 要删的分组 id。
     * @returns {object[]} 新列表。
     */
    function removeGroups(groups, ids) {
      const drop = new Set(ids);
      return groups.filter((group) => !drop.has(group.id));
    }

    /**
     * 改分组标题。
     * @param {object[]} groups - 现有分组。
     * @param {string} id - 分组 id。
     * @param {string} title - 新标题。
     * @returns {object[]} 新列表。
     */
    function renameGroup(groups, id, title) {
      const next = clampText(title, LIMITS.maxTitleLength);
      return groups.map((group) => (group.id === id ? { ...group, title: next, updatedAt: nowIso() } : group));
    }

    /**
     * 合并若干分组：成员按顺序取并集，新组放最前，源组删除。
     * @param {object[]} groups - 现有分组。
     * @param {string[]} ids - 源分组 id。
     * @param {string} title - 新组标题。
     * @returns {{groups: object[], group: object}} 新列表与新分组。
     */
    function mergeGroupList(groups, ids, title) {
      const drop = new Set(ids);
      const selected = groups.filter((group) => drop.has(group.id));
      const seen = new Set();
      const memberIds = [];
      for (const group of selected) {
        for (const id of group.sessionIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          memberIds.push(id);
          if (memberIds.length >= LIMITS.maxSessionsPerGroup) break;
        }
      }
      const stamp = nowIso();
      const group = {
        id: uid('grp'),
        title: clampText(title, LIMITS.maxTitleLength),
        sessionIds: memberIds,
        createdAt: stamp,
        updatedAt: stamp,
      };
      return { groups: [group, ...groups.filter((item) => !drop.has(item.id))], group };
    }

    // -------------------------------------------------------------- 选择态

    /** 空选择。 */
    function emptySelection() {
      return { sessions: new Set(), workspaces: new Set(), groups: new Set() };
    }

    /**
     * 复制选择态（React 要求新对象）。
     * @param {object} selection - 选择态。
     * @returns {object} 副本。
     */
    function cloneSelection(selection) {
      return {
        sessions: new Set(selection.sessions),
        workspaces: new Set(selection.workspaces),
        groups: new Set(selection.groups),
      };
    }

    /**
     * 切换一个 id 的选中状态。
     * @param {object} selection - 选择态。
     * @param {'sessions'|'workspaces'|'groups'} key - 维度。
     * @param {string} id - 目标 id。
     * @returns {object} 新选择态。
     */
    function toggleIn(selection, key, id) {
      const next = cloneSelection(selection);
      const set = next[key];
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return next;
    }

    // ------------------------------------------------------------ 本地偏好

    /**
     * 安全读取 JSON。
     * @param {string} key - 键。
     * @returns {unknown} 值或 null。
     */
    function readJson(key) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    }

    /**
     * 安全写入 JSON。
     * @param {string} key - 键。
     * @param {unknown} value - 值。
     * @returns {boolean} 是否成功。
     */
    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 读 dsh_tishi 的隐藏工作区集合（只读；缺失/损坏/没有 storage 都当作没有隐藏）。
     * @param {Storage|undefined} storage - localStorage 或测试桩。
     * @returns {Set<string>} 隐藏的 workspaceId 集合。
     */
    function readTishiHiddenWorkspaceIds(storage) {
      const result = new Set();
      if (storage === undefined || storage === null || typeof storage.getItem !== 'function') return result;
      let raw = null;
      try {
        raw = storage.getItem(TISHI_HIDDEN_KEY);
      } catch {
        return result;
      }
      if (typeof raw !== 'string' || raw === '') return result;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return result;
      }
      const ids = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ids) ? parsed.ids : [];
      for (const id of ids) {
        if (typeof id === 'string' && id !== '') result.add(id);
      }
      return result;
    }

    /**
     * 比较两个 id 集合是否一致（轮询时避免无变化也重渲染）。
     * @param {Set<string>} left - 旧集合。
     * @param {Set<string>} right - 新集合。
     * @returns {boolean} 是否相同。
     */
    function sameIdSet(left, right) {
      if (left === right) return true;
      if (left.size !== right.size) return false;
      for (const id of left) {
        if (!right.has(id)) return false;
      }
      return true;
    }

    /**
     * 读界面偏好（开关与折叠态；分组本体不进 localStorage）。
     * @returns {{showArchived: boolean, showSubagent: boolean, showGroups: boolean, focusActive: boolean, showHidden: boolean, collapsed: string[]}} 偏好。
     */
    function loadUi() {
      const raw = readJson(LS_UI);
      if (raw === null || typeof raw !== 'object') {
        return { showArchived: false, showSubagent: false, showGroups: true, focusActive: false, showHidden: false, collapsed: [] };
      }
      return {
        showArchived: raw.showArchived === true,
        showSubagent: raw.showSubagent === true,
        showGroups: raw.showGroups !== false,
        focusActive: raw.focusActive === true,
        showHidden: raw.showHidden === true,
        collapsed: Array.isArray(raw.collapsed)
          ? raw.collapsed.filter((item) => typeof item === 'string').slice(0, 400)
          : [],
      };
    }

    /**
     * 写界面偏好。
     * @param {{showArchived: boolean, showSubagent: boolean, showGroups: boolean, focusActive: boolean, collapsed: Set<string>}} value - 偏好。
     * @returns {boolean} 是否成功。
     */
    function saveUi(value) {
      return writeJson(LS_UI, {
        version: 2,
        showArchived: value.showArchived === true,
        showSubagent: value.showSubagent === true,
        showGroups: value.showGroups !== false,
        focusActive: value.focusActive === true,
        collapsed: Array.from(value.collapsed ?? []),
      });
    }

    // -------------------------------------------------------------- 错误文本

    /**
     * 把任意错误压成一句可展示的文字。
     * @param {unknown} error - 错误。
     * @returns {string} 文字。
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      return String(error);
    }

    /** 缺标准 props 时的稳定空实现（hooks 顺序不变）。 */
    function noSnapshot() {
      return null;
    }

    /**
     * selector 的恒等投影：拿整个快照。
     * @param {unknown} value - 快照。
     * @returns {unknown} 同值。
     */
    function identity(value) {
      return value;
    }

    // ---------------------------------------------------------------- 文案

    const DICT = {
      zh: {
        'panel.title': '工作区图',
        'panel.subtitle': '真实工作区按目录归属；分组是插件自己的会话集合，可跨工作区。',
        'stat.workspaces': '工作区 {n}',
        'stat.sessions': '会话 {n}',
        'stat.unassigned': '未归入 {n}',
        'stat.groups': '分组 {n}',
        'toolbar.searchPlaceholder': '搜索会话标题、id 或工作区路径',
        'toolbar.focusActive': '只看进行中与未读完成',
        'toolbar.showArchived': '显示已归档',
        'toolbar.showHidden': '显示已隐藏 ({n})',
        'toolbar.showSubagent': '显示子代理会话',
        'toolbar.refresh': '刷新分组',
        'section.real': '真实工作区',
        'section.unassigned': '未归入工作区的会话',
        'section.groups': '分组',
        'empty.workspaces': '还没有工作区。',
        'empty.workspaceSessions': '这个工作区还没有会话。',
        'empty.unassigned': '没有未归入的会话。',
        'empty.groups': '还没有分组：勾选会话后点「新建分组」。',
        'empty.focus': '没有待处理、运行中或未读完成的会话。',
        'empty.groupSessions': '这个分组里的会话已经不在了。',
        'hint.unassigned': '会话归属由创建目录决定（cwd 不可变）；标了「可并入」的会话能收编进同目录工作区。',
        'badge.pending': '待处理',
        'badge.running': '运行中',
        'badge.done': '未读完成',
        'badge.pinned': '置顶',
        'badge.archived': '已归档',
        'badge.hiddenWs': '已隐藏',
        'badge.subagent': '子代理',
        'badge.adoptTo': '可并入「{title}」',
        'row.open': '打开',
        'row.startSession': '新会话',
        'row.rename': '改名',
        'row.delete': '删除',
        'row.save': '保存',
        'row.cancel': '取消',
        'row.detach': '解挂',
        'row.realize': '固化…',
        'row.confirmDelete': '确认删除',
        'count.sessions': '{n} 个会话',
        'count.running': '{n} 个运行中',
        'group.untitled': '未命名分组',
        'confirm.deleteWorkspace': '删除工作区「{title}」？只删登记：目录、会话、日志都不动；同目录的老会话之后可以再收编回来。',
        'confirm.deleteGroup': '删除分组「{title}」？只删分组，会话与工作区不受影响。',
        'sel.sessions': '已选 {n} 个会话',
        'sel.workspaces': '已选 {n} 个工作区',
        'sel.groups': '已选 {n} 个分组',
        'sel.mixed': '已选 {n} 项',
        'sel.hint': '同一类才能批量操作',
        'action.newGroup': '新建分组',
        'action.newWorkspace': '新建真实工作区…',
        'action.mergeWorkspaces': '合并为分组',
        'action.mergeGroups': '合并分组',
        'action.deleteGroups': '删除分组',
        'action.clear': '清除选择',
        'dialog.newWorkspace': '新建真实工作区',
        'dialog.newGroup': '新建分组',
        'dialog.mergeGroups': '合并分组',
        'field.path': '目录（必须已存在）',
        'field.title': '标题',
        'field.adopt': '把会话收编进来（只有同目录的会话能成功）',
        'field.pickDirectory': '选择目录…',
        'field.preview': '预演：{ok} 个可收编，{no} 个目录不同',
        'field.members': '成员 {n} 个',
        'field.sidebarVisibility': '侧栏可见性',
        'field.hintPath': 'DSH 工作区必须指向一个已存在的目录；目录不存在会由宿主拒绝并给出原因。',
        'btn.create': '创建',
        'btn.merge': '合并',
        'msg.loading': '正在加载分组…',
        'msg.loadingWorkspaces': '正在加载工作区…',
        'msg.degraded': '当前界面没有提供工作区/会话数据（缺少标准 props），只能显示提示。',
        'msg.noWorkspaceService': '当前界面不支持工作区操作（缺少 workspaces 服务）',
        'msg.noUiWorkspace': '当前界面不支持打开会话或选目录（缺少 uiWorkspace 服务）',
        'msg.http': 'HTTP {status}',
        'msg.groupsFailed': '读取分组失败：{msg}',
        'msg.saveFailed': '保存分组失败：{msg}',
        'msg.createFailed': '创建失败：{msg}',
        'msg.attachFailed': '收编失败：{msg}',
        'msg.noAdopt': '没有可收编的会话',
        'msg.deleteFailed': '删除失败：{msg}',
        'msg.renameFailed': '改名失败：{msg}',
        'msg.openFailed': '打开失败：{msg}',
        'msg.detachFailed': '解挂失败：{msg}',
        'msg.workspaceReady': '工作区「{title}」已就绪',
        'msg.adopted': '已收编 {n} 个会话',
        'msg.skipped': '{n} 个目录不同未收编',
        'msg.deleted': '已删除工作区「{title}」',
        'msg.renamed': '已改名',
        'msg.groupCreated': '已新建分组「{title}」',
        'msg.groupMerged': '已合并为分组「{title}」',
        'msg.groupsDeleted': '已删除分组',
        'msg.detached': '已从工作区解挂',
        'msg.detachedAbsent': '该会话本来就不在这个工作区',
        'msg.realized': '已固化为真实工作区；分组保留，不需要时手动删除',
        'msg.pathRequired': '先填一个已存在的目录',
        'msg.needSessions': '先勾选至少一个会话',
        'msg.needTwoGroups': '至少勾选两个分组',
        'msg.needWorkspaces': '至少勾选一个工作区',
        'detail.title': '未收编明细',
        'reason.cwd-mismatch': '目录不同',
        'reason.no-cwd': '会话没有记录目录',
        'reason.cwd-unresolved': '目录无法解析',
        'reason.not-found': '会话不存在',
        'reason.failed': '其他失败',
        'time.justNow': '刚刚',
        'time.minutes': '{n} 分钟前',
        'time.hours': '{n} 小时前',
        'time.today': '今天 {time}',
        'time.yesterday': '昨天 {time}',
        'time.date': '{date}',
        'a11y.selectSession': '选择会话',
        'a11y.selectWorkspace': '选择工作区',
        'a11y.selectGroup': '选择分组',
        'a11y.expand': '展开',
        'a11y.collapse': '收起',
        'footer.storage': '分组数据存在 %DSH_HOME%\\workspace-graph\\groups.json，跨浏览器与端口共用。',
        'footer.limit': '真实工作区的成员只能来自同一目录；不同目录的会话请用分组。',
        'graph.hint': '滚轮缩放 · 拖空白平移 · 拖节点移动 · 双击会话打开',
        'graph.fit': '适应窗口',
        'graph.autoLayout': '自动排布',
        'graph.autoLayoutConfirm': '自动排布会覆盖你手动拖过的节点位置，继续吗？',
        'graph.expandAll': '全部展开',
        'graph.collapseAll': '全部收起',
        'graph.showGroups': '显示分组',
        'graph.reset': '重置视图',
        'graph.zoomIn': '放大',
        'graph.zoomOut': '缩小',
        'graph.stat': '{w} 节点 · {e} 连线',
        'graph.selectedCount': '已选 {n} 项',
        'graph.noSelection': '点一个节点看属性；展开 ▾ 才显示会话节点；Ctrl/Shift 可多选。',
        'panel.workspace': '工作区节点',
        'panel.session': '会话节点',
        'panel.group': '分组节点',
        'panel.overview': '概览',
        'panel.multi': '多选',
        'panel.sessions': '会话 {n}',
        'panel.running': '运行中 {n}',
        'panel.members': '成员 {n}',
        'panel.inWorkspace': '所属工作区',
        'panel.forkParent': '父会话',
        'panel.status': '状态',
        'status.idle': '空闲',
        'status.approval': '等待授权',
        'status.question': '等待回答',
        'status.planReview': '等待确认计划',
        'status.summary': '待处理 {p} · 运行中 {r} · 未读完成 {d}',
        'status.legend': '状态角标：橙 待处理 · 蓝 运行中 · 绿 未读完成（节点左侧色条同色；数字为会话数）',
        'panel.none': '无',
        'action.selectSessions': '选中本工作区会话',
        'action.adoptable': '可并入的会话 {n}',
        'action.oneClickWorkspace': '一键建工作区',
        'action.adoptInto': '一键归入「{title}」',
        'msg.needCommonDir': '选中的会话目录不同，无法一键建工作区；已打开对话框，请选择目录',
        'msg.crashed': '工作区图渲染出错：{msg}',
        'action.retry': '重试',
        'action.resetLayout': '重置布局',
        'msg.layoutFailed': '保存布局失败：{msg}',
        'msg.layoutReset': '布局已重置（下次自动排布）',
        'msg.autoLayoutDone': '已自动排布并保存',
        'badge.group': '分组',
        'label.workspaces': '工作区',
        'label.sessions': '会话',
        'label.unassigned': '未归入',
        'label.groups': '分组',
        'label.hiddenInSidebar': '侧栏中隐藏',
        'label.running': '运行中',
        'label.members': '成员',
        'label.recent': '最近 {time}',
        'hint.hiddenWs': '这些工作区在侧栏被「隐藏工作区」藏起来了；勾选「显示已隐藏」可在图上看到它们，恢复请用侧栏右键「已隐藏的工作区」。',
        'value.hiddenInSidebar': '已隐藏（右键「已隐藏的工作区」可恢复）',
      },
      en: {
        'panel.title': 'Workspace Graph',
        'panel.subtitle': 'Real workspaces follow their directory; groups are this plugin\'s own session sets and may span workspaces.',
        'stat.workspaces': 'Workspaces {n}',
        'stat.sessions': 'Sessions {n}',
        'stat.unassigned': 'Unassigned {n}',
        'stat.groups': 'Groups {n}',
        'toolbar.searchPlaceholder': 'Search session title, id, or workspace path',
        'toolbar.focusActive': 'Active & unread',
        'toolbar.showArchived': 'Show archived',
        'toolbar.showHidden': 'Show hidden ({n})',
        'toolbar.showSubagent': 'Show subagent sessions',
        'toolbar.refresh': 'Reload groups',
        'section.real': 'Real workspaces',
        'section.unassigned': 'Sessions in no workspace',
        'section.groups': 'Groups',
        'empty.workspaces': 'No workspaces yet.',
        'empty.workspaceSessions': 'This workspace has no sessions yet.',
        'empty.unassigned': 'No unassigned sessions.',
        'empty.groups': 'No groups yet: select sessions and press New group.',
        'empty.focus': 'No pending, running, or unread-done sessions.',
        'empty.groupSessions': 'Every session in this group is gone.',
        'hint.unassigned': 'A session belongs to the directory it was created in (its cwd never changes); sessions marked as joinable can be adopted into the workspace of that directory.',
        'badge.pending': 'Pending',
        'badge.running': 'Running',
        'badge.done': 'Unread done',
        'badge.pinned': 'Pinned',
        'badge.archived': 'Archived',
        'badge.hiddenWs': 'Hidden',
        'badge.subagent': 'Subagent',
        'badge.adoptTo': 'Joinable: {title}',
        'row.open': 'Open',
        'row.startSession': 'New session',
        'row.rename': 'Rename',
        'row.delete': 'Delete',
        'row.save': 'Save',
        'row.cancel': 'Cancel',
        'row.detach': 'Detach',
        'row.realize': 'Make real…',
        'row.confirmDelete': 'Confirm delete',
        'count.sessions': '{n} sessions',
        'count.running': '{n} running',
        'group.untitled': 'Untitled group',
        'confirm.deleteWorkspace': 'Delete workspace "{title}"? This removes the registration only: directory, sessions, and logs stay; sessions from that directory can be adopted back later.',
        'confirm.deleteGroup': 'Delete group "{title}"? Only the group goes away; sessions and workspaces are untouched.',
        'sel.sessions': '{n} sessions selected',
        'sel.workspaces': '{n} workspaces selected',
        'sel.groups': '{n} groups selected',
        'sel.mixed': '{n} items selected',
        'sel.hint': 'Batch actions need one kind at a time',
        'action.newGroup': 'New group',
        'action.newWorkspace': 'New real workspace…',
        'action.mergeWorkspaces': 'Merge into group',
        'action.mergeGroups': 'Merge groups',
        'action.deleteGroups': 'Delete groups',
        'action.clear': 'Clear selection',
        'dialog.newWorkspace': 'New real workspace',
        'dialog.newGroup': 'New group',
        'dialog.mergeGroups': 'Merge groups',
        'field.path': 'Directory (must already exist)',
        'field.title': 'Title',
        'field.adopt': 'Adopt these sessions (only sessions in that exact directory succeed)',
        'field.pickDirectory': 'Choose directory…',
        'field.preview': 'Preview: {ok} adoptable, {no} in a different directory',
        'field.members': '{n} members',
        'field.sidebarVisibility': 'Sidebar visibility',
        'field.hintPath': 'A DSH workspace must point at an existing directory; the host rejects a missing one and reports why.',
        'btn.create': 'Create',
        'btn.merge': 'Merge',
        'msg.loading': 'Loading groups…',
        'msg.loadingWorkspaces': 'Loading workspaces…',
        'msg.degraded': 'This surface provides no workspace/session data (standard props missing).',
        'msg.noWorkspaceService': 'Workspace operations are unavailable here (missing the workspaces service)',
        'msg.noUiWorkspace': 'Opening sessions or picking directories is unavailable here (missing uiWorkspace)',
        'msg.http': 'HTTP {status}',
        'msg.groupsFailed': 'Could not read groups: {msg}',
        'msg.saveFailed': 'Could not save groups: {msg}',
        'msg.createFailed': 'Create failed: {msg}',
        'msg.attachFailed': 'Adoption failed: {msg}',
        'msg.noAdopt': 'No sessions to adopt',
        'msg.deleteFailed': 'Delete failed: {msg}',
        'msg.renameFailed': 'Rename failed: {msg}',
        'msg.openFailed': 'Open failed: {msg}',
        'msg.detachFailed': 'Detach failed: {msg}',
        'msg.workspaceReady': 'Workspace "{title}" is ready',
        'msg.adopted': '{n} sessions adopted',
        'msg.skipped': '{n} skipped (different directory)',
        'msg.deleted': 'Deleted workspace "{title}"',
        'msg.renamed': 'Renamed',
        'msg.groupCreated': 'Created group "{title}"',
        'msg.groupMerged': 'Merged into group "{title}"',
        'msg.groupsDeleted': 'Groups deleted',
        'msg.detached': 'Session detached from the workspace',
        'msg.detachedAbsent': 'That session was not in this workspace',
        'msg.realized': 'Made into a real workspace; the group is kept, delete it when unneeded',
        'msg.pathRequired': 'Fill in an existing directory first',
        'msg.needSessions': 'Select at least one session first',
        'msg.needTwoGroups': 'Select at least two groups',
        'msg.needWorkspaces': 'Select at least one workspace',
        'detail.title': 'Sessions not adopted',
        'reason.cwd-mismatch': 'different directory',
        'reason.no-cwd': 'session records no directory',
        'reason.cwd-unresolved': 'directory cannot be resolved',
        'reason.not-found': 'session not found',
        'reason.failed': 'other failure',
        'time.justNow': 'just now',
        'time.minutes': '{n} min ago',
        'time.hours': '{n} h ago',
        'time.today': 'today {time}',
        'time.yesterday': 'yesterday {time}',
        'time.date': '{date}',
        'a11y.selectSession': 'Select session',
        'a11y.selectWorkspace': 'Select workspace',
        'a11y.selectGroup': 'Select group',
        'a11y.expand': 'Expand',
        'a11y.collapse': 'Collapse',
        'footer.storage': 'Groups live in %DSH_HOME%\\workspace-graph\\groups.json and are shared across browsers and ports.',
        'footer.limit': 'Real workspaces only accept sessions created in the same directory; use groups for the rest.',
        'graph.hint': 'Wheel zooms · drag empty space to pan · drag nodes · double-click a session to open',
        'graph.fit': 'Fit',
        'graph.autoLayout': 'Auto layout',
        'graph.autoLayoutConfirm': 'Auto layout overwrites the positions you dragged. Continue?',
        'graph.expandAll': 'Expand all',
        'graph.collapseAll': 'Collapse all',
        'graph.showGroups': 'Show groups',
        'graph.reset': 'Reset view',
        'graph.zoomIn': 'Zoom in',
        'graph.zoomOut': 'Zoom out',
        'graph.stat': '{w} nodes · {e} edges',
        'graph.selectedCount': '{n} selected',
        'graph.noSelection': 'Pick a node to see its properties; expand ▾ to reveal session nodes; Ctrl/Shift selects more.',
        'panel.workspace': 'Workspace node',
        'panel.session': 'Session node',
        'panel.group': 'Group node',
        'panel.overview': 'Overview',
        'panel.multi': 'Multiple',
        'panel.sessions': 'Sessions {n}',
        'panel.running': 'Running {n}',
        'panel.members': 'Members {n}',
        'panel.inWorkspace': 'Workspace',
        'panel.forkParent': 'Parent session',
        'panel.status': 'Status',
        'status.idle': 'Idle',
        'status.approval': 'Awaiting approval',
        'status.question': 'Awaiting answer',
        'status.planReview': 'Awaiting plan review',
        'status.summary': 'Pending {p} · Running {r} · Unread done {d}',
        'status.legend': 'Status badges: amber pending · blue running · green unread done (node left strips match; numbers are session counts)',
        'panel.none': 'none',
        'action.selectSessions': 'Select all sessions in this workspace',
        'action.adoptable': 'Joinable sessions {n}',
        'action.oneClickWorkspace': 'Create workspace in one click',
        'action.adoptInto': 'Adopt into "{title}"',
        'msg.needCommonDir': 'Selected sessions live in different directories; opening the dialog so you can pick one',
        'msg.crashed': 'The workspace graph failed to render: {msg}',
        'action.retry': 'Retry',
        'action.resetLayout': 'Reset layout',
        'msg.layoutFailed': 'Could not save the layout: {msg}',
        'msg.layoutReset': 'Layout reset (auto layout applies next)',
        'msg.autoLayoutDone': 'Auto layout applied and saved',
        'badge.group': 'Group',
        'label.workspaces': 'Workspaces',
        'label.sessions': 'Sessions',
        'label.unassigned': 'Unassigned',
        'label.groups': 'Groups',
        'label.hiddenInSidebar': 'Hidden in sidebar',
        'label.running': 'Running',
        'label.members': 'Members',
        'label.recent': 'Last {time}',
        'hint.hiddenWs': 'These workspaces are hidden from the sidebar by “Hide workspace”; tick “Show hidden” to see them here. Restore them from the sidebar context menu “Hidden workspaces”.',
        'value.hiddenInSidebar': 'Hidden (restore via “Hidden workspaces”)',
      },
    };

    /**
     * 造一个带 `{var}` 插值的翻译函数。
     * @param {Function} bound - ctx.locale.bind(NS) 的结果。
     * @returns {(key: string, vars?: object) => string} 翻译函数。
     */
    function makeT(bound) {
      return function translate(key, vars) {
        let text = '';
        try {
          text = bound(key);
        } catch {
          text = '';
        }
        if (typeof text !== 'string' || text === '' || text === key) {
          text = DICT.zh[key] === undefined ? key : DICT.zh[key];
        }
        if (vars !== undefined && vars !== null) {
          text = text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
        }
        return text;
      };
    }

    // ---------------------------------------------------------------- 样式

    const CSS = [
      '.wg-root{height:100%;overflow-y:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.wg-wrap{max-width:1060px;margin:0 auto;padding:calc(var(--dsh-frame-top-clearance,48px) + 18px) 28px 72px;box-sizing:border-box}',
      '.wg-h1{margin:0;font-size:21px;font-weight:650;letter-spacing:.01em}',
      '.wg-sub{margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      '.wg-stats{display:flex;gap:14px;flex-wrap:wrap;margin:12px 0 2px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.wg-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 4px}',
      '.wg-input{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:7px 10px;box-sizing:border-box;width:100%}',
      '.wg-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.wg-search{flex:1 1 240px;min-width:180px;max-width:420px;width:auto}',
      '.wg-toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.wg-btn{font:inherit;font-size:12.5px;line-height:1;padding:8px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.wg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.wg-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.wg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.wg-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:600}',
      '.wg-btn-primary:hover:not(:disabled){opacity:.92;background:var(--dsw-alias-brand-primary)}',
      '.wg-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.wg-btn-mini{padding:5px 9px;font-size:11.5px;border-radius:7px}',
      '.wg-section{margin-top:16px}',
      '.wg-section-head{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:12px;font-weight:650;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}',
      '.wg-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:6px 10px;margin-bottom:10px}',
      '.wg-card-ws{border-left:2px solid var(--dsw-alias-brand-primary)}',
      '.wg-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:8px;min-width:0}',
      '.wg-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.wg-row-head{font-weight:600}',
      '.wg-check{flex:0 0 auto;margin:0;cursor:pointer}',
      '.wg-caret{flex:0 0 auto;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;font-size:11px;padding:0}',
      '.wg-caret:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.wg-content{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.wg-title{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
      '.wg-title-ws{font-size:13.5px;font-weight:650}',
      '.wg-mono{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}',
      '.wg-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.wg-indent{display:inline-block;width:18px;flex:0 0 18px}',
      '.wg-glyph{color:var(--dsw-alias-label-secondary);font-size:11px;flex:0 0 auto}',
      '.wg-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;border:1px solid transparent}',
      '.wg-chip-run{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:650}',
      '.wg-chip-pending{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 76%,var(--dsw-alias-label-primary));font-weight:650}',
      '.wg-chip-done{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 70%,var(--dsw-alias-label-primary));font-weight:650}',
      '.wg-chip-warn{background:transparent;border:1px solid var(--dsw-alias-border-l2)}',
      '.wg-chip-muted{background:transparent;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.wg-actions{flex:0 0 auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}',
      '.wg-empty{font-size:12.5px;color:var(--dsw-alias-label-secondary);padding:8px 4px}',
      '.wg-hint{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);margin:6px 0}',
      '.wg-status{margin:10px 0;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:1.55;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.wg-status-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.wg-status-warn{border-color:var(--dsw-alias-border-l2)}',
      '.wg-detail{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.wg-selbar{position:sticky;bottom:0;z-index:2;margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 -6px 20px rgba(0,0,0,.08)}',
      '.wg-seltext{font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.wg-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.36);padding:20px;box-sizing:border-box}',
      '.wg-dialog{width:min(580px,100%);max-height:86vh;overflow:auto;box-sizing:border-box;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);padding:18px}',
      '.wg-dialog h3{margin:0 0 4px;font-size:16px;font-weight:650}',
      '.wg-field{display:flex;flex-direction:column;gap:6px;margin-top:12px}',
      '.wg-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.wg-field-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.wg-field-row .wg-input{flex:1 1 220px}',
      '.wg-dialog-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}',
      '.wg-list{list-style:none;margin:8px 0 0;padding:0;max-height:180px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:9px}',
      '.wg-list li{display:flex;gap:8px;justify-content:space-between;padding:6px 10px;font-size:12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.wg-list li:first-child{border-top:none}',
      '.wg-footer{margin-top:18px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
    ].join('');

    // -------------------------------------------------------------- 界面零件

    /**
     * 小按钮。
     * @param {object} props - React props。
     * @returns {object} React 元素。
     */
    function Btn(props) {
      let cls = 'wg-btn';
      if (props.variant === 'primary') cls += ' wg-btn-primary';
      if (props.variant === 'danger') cls += ' wg-btn-danger';
      if (props.mini === true) cls += ' wg-btn-mini';
      return h(
        'button',
        {
          type: 'button',
          className: cls,
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
          'aria-label': props.title,
        },
        props.children,
      );
    }

    /**
     * 状态小标签。
     * @param {object} props - `{tone, title, children}`。
     * @returns {object} React 元素。
     */
    function Chip(props) {
      let cls = 'wg-chip';
      if (props.tone === 'run') cls += ' wg-chip-run';
      if (props.tone === 'pending') cls += ' wg-chip-pending';
      if (props.tone === 'done') cls += ' wg-chip-done';
      if (props.tone === 'warn') cls += ' wg-chip-warn';
      if (props.tone === 'muted') cls += ' wg-chip-muted';
      return h('span', { className: cls, title: props.title }, props.children);
    }

    /**
     * 复选按钮。
     * @param {object} props - `{checked, label, onChange}`。
     * @returns {object} React 元素。
     */
    function Check(props) {
      return h('input', {
        type: 'checkbox',
        className: 'wg-check',
        checked: props.checked === true,
        'aria-label': props.label,
        title: props.label,
        onChange: (event) => props.onChange(event.target.checked),
      });
    }

    /**
     * 轻量对话框：背板点击 / Esc 关闭，打开时挂监听、卸载即移除。
     * @param {object} props - `{title, subtitle, busy, submitText, cancelText, onClose, onSubmit, children}`。
     * @returns {object} React 元素。
     */
    function Dialog(props) {
      const latest = React.useRef({ onClose: props.onClose, busy: props.busy });
      latest.current = { onClose: props.onClose, busy: props.busy };
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          const current = latest.current;
          if (current.busy === true) return;
          current.onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, []);
      return h(
        'div',
        {
          className: 'wg-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && props.busy !== true) props.onClose();
          },
        },
        h(
          'div',
          { className: 'wg-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h('h3', null, props.title),
          props.subtitle === undefined ? null : h('div', { className: 'wg-hint' }, props.subtitle),
          props.children,
          h(
            'div',
            { className: 'wg-dialog-actions' },
            h(Btn, { onClick: props.onClose, disabled: props.busy === true }, props.cancelText),
            h(Btn, { variant: 'primary', onClick: props.onSubmit, disabled: props.busy === true }, props.submitText),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------- 图标

    /**
     * 侧栏图标（只吃 size / active）。
     * @param {object} props - `{size, active}`。
     * @returns {object} React 元素。
     */
    function Icon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      const color = props.active === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', color },
        },
        h('circle', { key: 'a', cx: 5.5, cy: 6.5, r: 2.1 }),
        h('circle', { key: 'b', cx: 5.5, cy: 17.5, r: 2.1 }),
        h('circle', { key: 'c', cx: 18.5, cy: 12, r: 2.2 }),
        h('path', { key: 'd', d: 'M7.7 6.9c2.4.6 4.4 1.9 5.6 3.6' }),
        h('path', { key: 'e', d: 'M7.7 17.1c2.4-.6 4.4-1.9 5.6-3.6' }),
      );
    }

    // -------------------------------------------------------------- 面板主体

    // ============================================================ 节点图纯函数
    // 这一层不碰 React、不碰 DOM：给定数据算出「有哪些节点、连哪些线、放哪儿」，
    // 供渲染层直接用，也便于离线测试。

    /**
     * 容器节点的键：`ws:<id>` / `grp:<id>` / `unassigned`。
     * @param {'ws'|'grp'|'unassigned'} kind - 节点类型。
     * @param {string} [id] - 工作区/分组 id。
     * @returns {string} 键。
     */
    function containerKey(kind, id) {
      if (kind === 'unassigned') return 'unassigned';
      return `${kind}:${id}`;
    }

    /**
     * 会话节点的键。
     * @param {string} id - 会话 id。
     * @returns {string} 键。
     */
    function sessionKey(id) {
      return `sess:${id}`;
    }

    /**
     * 按「已登记的目录嵌套」找父工作区：取最长前缀，且边界必须是路径分隔符。
     * @param {object} workspace - WorkspaceView。
     * @param {object[]} workspaces - 全部工作区。
     * @returns {object|null} 父工作区或 null。
     */
    function pathParentOf(workspace, workspaces) {
      const own = canonicalKey(workspace?.path);
      if (own === '') return null;
      let best = null;
      let bestLength = -1;
      for (const other of Array.isArray(workspaces) ? workspaces : []) {
        if (other === null || typeof other !== 'object') continue;
        if (other.workspaceId === workspace.workspaceId) continue;
        const key = canonicalKey(other.path);
        if (key === '' || key === own) continue;
        if (!own.startsWith(`${key}/`)) continue;
        if (key.length > bestLength) {
          best = other;
          bestLength = key.length;
        }
      }
      return best;
    }

    /**
     * 把工作区排成森林（父子 = 目录嵌套），并给出每个工作区的层深。
     * @param {object[]} workspaces - WorkspaceView 数组。
     * @returns {{list: object[], parentOf: Map<string,string>, childrenOf: Map<string,string[]>, roots: string[], depthOf: (id: string) => number}} 森林。
     */
    function buildWorkspaceForest(workspaces) {
      const list = (Array.isArray(workspaces) ? workspaces : []).filter(
        (item) => item !== null && typeof item === 'object' && typeof item.workspaceId === 'string',
      );
      const parentOf = new Map();
      const childrenOf = new Map();
      for (const item of list) {
        const parent = pathParentOf(item, list);
        parentOf.set(item.workspaceId, parent === null ? '' : parent.workspaceId);
        if (parent === null) continue;
        const children = childrenOf.get(parent.workspaceId);
        if (children === undefined) childrenOf.set(parent.workspaceId, [item.workspaceId]);
        else children.push(item.workspaceId);
      }
      const roots = list.filter((item) => parentOf.get(item.workspaceId) === '').map((item) => item.workspaceId);
      const depthOf = (id) => {
        let depth = 0;
        let cursor = id;
        const seen = new Set([id]);
        while (depth < MAX_LAYER) {
          const parent = parentOf.get(cursor);
          if (parent === undefined || parent === '' || seen.has(parent)) break;
          seen.add(parent);
          cursor = parent;
          depth += 1;
        }
        return depth;
      };
      return { list, parentOf, childrenOf, roots, depthOf };
    }

    /**
     * 会话的 fork 世代（沿 parentId 往上数，封顶 4）。
     * @param {object} summary - SessionSummary。
     * @param {Record<string, object>} byId - 会话行。
     * @param {number} [cap] - 上限。
     * @returns {number} 世代。
     */
    function sessionForkDepth(summary, byId, cap = 4) {
      let depth = 0;
      let cursor = summary;
      const seen = new Set([summary?.id]);
      while (depth < cap) {
        const parentId = cursor !== null && typeof cursor === 'object' && typeof cursor.parentId === 'string' ? cursor.parentId : '';
        if (parentId === '' || seen.has(parentId)) break;
        const parent = byId[parentId];
        if (parent === undefined) break;
        seen.add(parentId);
        cursor = parent;
        depth += 1;
      }
      return depth;
    }

    /**
     * 造出图：节点（带层深/排序键）、连线、统计。
     *
     * 层深规则：工作区 = 目录深度；会话 = 所属工作区 + fork 世代 + 1；
     * 分组 = 成员最大层 + 1；未归入 = 0，其会话 = 1。全部封顶 MAX_LAYER。
     *
     * @param {object} input - `{workspaces, groups, list, options, expanded, showHidden, hiddenWorkspaceIds, showGroups, focusActive, query, pinnedIds, statuses}`。
     * @returns {{nodes: object[], edges: object[], stats: object, unassignedCount: number}} 图。
     */
    function buildGraph(input) {
      const source = input === null || input === undefined ? {} : input;
      const workspaces = Array.isArray(source.workspaces) ? source.workspaces : [];
      const groups = Array.isArray(source.groups) ? source.groups : [];
      const list = source.list === null || source.list === undefined ? null : source.list;
      const byId = list !== null && typeof list === 'object' && list.byId !== undefined ? list.byId : {};
      const ids = list !== null ? (Array.isArray(list.ids) ? list.ids : Object.keys(byId)) : [];
      const options = source.options === undefined ? { showArchived: false, showSubagent: false, archivedIds: new Set() } : source.options;
      const expanded = source.expanded instanceof Set ? source.expanded : new Set();
      const focusActive = source.focusActive === true;
      const hiddenWorkspaceIds = source.hiddenWorkspaceIds instanceof Set ? source.hiddenWorkspaceIds : new Set();
      const showGroups = source.showGroups !== false && !focusActive;
      const query = typeof source.query === 'string' ? source.query.trim().toLowerCase() : '';
      const searching = query !== '';
      // 隐藏只在普通视图生效：搜索/聚焦要保证命中和进行中的链条可见。
      const respectHidden = source.showHidden !== true && !focusActive && !searching;
      const matchesText = (value) => !searching || String(value === undefined || value === null ? '' : value).toLowerCase().includes(query);
      const matchesSession = (summary) => !searching || matchesText(summaryTitle(summary)) || matchesText(summary?.id);
      const filtered = (id) => byId[id] !== undefined && visibleSummary(byId[id], options) && matchesSession(byId[id]);
      const fallbackGroupTitle = typeof source.groupFallbackTitle === 'string' && source.groupFallbackTitle !== '' ? source.groupFallbackTitle : 'group';
      const unassignedTitle = typeof source.unassignedTitle === 'string' && source.unassignedTitle !== '' ? source.unassignedTitle : 'unassigned';
      const statuses = source.statuses === undefined ? null : source.statuses;
      const archivedForStates = options.archivedIds instanceof Set ? options.archivedIds : new Set();
      // 聚焦 = 注意力视图：待处理 / 运行中 / 未读完成（跑完但还没看，同样需要关注）。
      const focusQualified = (sessionId, summary) => {
        if (!focusActive) return true;
        const state = sessionState(statusOf(statuses, sessionId), summary);
        return state === 'running' || state === 'pending' || state === 'done';
      };

      const forest = buildWorkspaceForest(workspaces);
      const ownerOf = new Map();
      for (const workspace of forest.list) {
        for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          ownerOf.set(sessionId, workspace.workspaceId);
        }
      }
      const groupIdsOf = new Map();
      for (const group of groups) {
        for (const sessionId of Array.isArray(group.sessionIds) ? group.sessionIds : []) {
          const bucket = groupIdsOf.get(sessionId);
          if (bucket === undefined) groupIdsOf.set(sessionId, [group.id]);
          else bucket.push(group.id);
        }
      }

      const wsIndex = new Map();
      forest.list.forEach((workspace, index) => wsIndex.set(workspace.workspaceId, index));
      const wsDepth = new Map();
      for (const workspace of forest.list) wsDepth.set(workspace.workspaceId, forest.depthOf(workspace.workspaceId));

      const visibleSessions = new Set();
      const unassignedIds = [];
      for (const sessionId of ids) {
        const summary = byId[sessionId];
        if (summary === undefined || !visibleSummary(summary, options)) continue;
        if (searching && !matchesSession(summary)) continue;
        if (!focusQualified(sessionId, summary)) continue;
        const workspaceId = ownerOf.get(sessionId);
        if (respectHidden && workspaceId !== undefined && hiddenWorkspaceIds.has(workspaceId)) continue;
        const viaWorkspace = workspaceId !== undefined && expanded.has(containerKey('ws', workspaceId));
        const viaGroup = showGroups && (groupIdsOf.get(sessionId) ?? []).some((groupId) => expanded.has(containerKey('grp', groupId)));
        const viaHub = workspaceId === undefined && expanded.has('unassigned');
        if (focusActive || searching || viaWorkspace || viaGroup || viaHub) visibleSessions.add(sessionId);
        if (workspaceId === undefined) unassignedIds.push(sessionId);
      }

      // 聚焦模式：把每个待关注会话（待处理/运行中/未读完成）的 workspace 祖先链全部拉出来，
      // 这样不用展开也能看到「工作区 → 会话」这条链。
      const focusWsIds = new Set();
      if (focusActive) {
        for (const sessionId of visibleSessions) {
          let cursorId = ownerOf.get(sessionId);
          while (cursorId !== undefined && !focusWsIds.has(cursorId)) {
            focusWsIds.add(cursorId);
            const parentId = forest.parentOf.get(cursorId);
            cursorId = parentId === '' || parentId === undefined ? undefined : parentId;
          }
        }
      }

      const nodes = [];
      const push = (node) => {
        nodes.push(node);
      };

      let hiddenWorkspaceCount = 0;
      for (const workspace of forest.list) {
        const hiddenInSidebar = hiddenWorkspaceIds.has(workspace.workspaceId);
        if (hiddenInSidebar) hiddenWorkspaceCount += 1;
        if (respectHidden && hiddenInSidebar) continue;
        if (focusActive && !focusWsIds.has(workspace.workspaceId)) continue;
        const index = wsIndex.get(workspace.workspaceId) ?? 0;
        const memberIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        const members = focusActive
          ? memberIds.filter((sessionId) => visibleSessions.has(sessionId))
          : memberIds.filter((sessionId) => filtered(sessionId));
        const running = members.filter((sessionId) => byId[sessionId]?.running === true).length;
        const title = workspace.title || basenameOf(workspace.path);
        const parentId = forest.parentOf.get(workspace.workspaceId) ?? '';
        push({
          key: containerKey('ws', workspace.workspaceId),
          kind: 'ws',
          id: workspace.workspaceId,
          title,
          path: workspace.path,
          layer: Math.min(MAX_LAYER, wsDepth.get(workspace.workspaceId) ?? 0),
          rank: 0,
          ownerIndex: index,
          itemIndex: 0,
          parentKey: parentId === '' ? '' : containerKey('ws', parentId),
          dim: !focusActive && searching && !matchesText(title) && !matchesText(workspace.path) && members.length === 0,
          hiddenInSidebar: hiddenWorkspaceIds.has(workspace.workspaceId),
          counts: { sessions: members.length, running },
          states: aggregateStates(focusActive ? members : memberIds, byId, statuses, archivedForStates),
          updatedAt: latestActivity(members, byId),
          ref: workspace,
          memberIds,
        });
      }

      // 会话节点：先收集，再按「置顶 → 最近对话时间倒序」对**同级**排序，最后写 itemIndex。
      const pinned = source.pinnedIds instanceof Set ? source.pinnedIds : new Set();
      const layerOfSession = new Map();
      const sessionEntries = [];
      for (const sessionId of ids) {
        if (!visibleSessions.has(sessionId)) continue;
        const summary = byId[sessionId];
        const workspaceId = ownerOf.get(sessionId);
        const base = workspaceId === undefined ? 0 : (wsDepth.get(workspaceId) ?? 0);
        const layer = Math.min(MAX_LAYER, base + sessionForkDepth(summary, byId) + 1);
        layerOfSession.set(sessionId, layer);
        const ownerIndex = workspaceId === undefined ? forest.list.length + 1 : (wsIndex.get(workspaceId) ?? 0);
        const forkParent = typeof summary.parentId === 'string' ? summary.parentId : '';
        // 排版父子：fork 父会话可见时挂在它下面，否则挂在自己的工作区（或「未归入」），
        // 这样展开后会话节点紧贴所属容器，而不是散在整列。
        const layoutParent = forkParent !== '' && visibleSessions.has(forkParent)
          ? sessionKey(forkParent)
          : workspaceId === undefined
            ? 'unassigned'
            : containerKey('ws', workspaceId);
        sessionEntries.push({ sessionId, summary, workspaceId, layer, ownerIndex, layoutParent });
      }
      const siblingBuckets = new Map();
      for (const entry of sessionEntries) {
        const bucket = siblingBuckets.get(entry.layoutParent);
        if (bucket === undefined) siblingBuckets.set(entry.layoutParent, [entry]);
        else bucket.push(entry);
      }
      for (const bucket of siblingBuckets.values()) {
        bucket.sort((left, right) => compareSessionsForDisplay(left.summary, right.summary, pinned));
      }
      for (const bucket of siblingBuckets.values()) {
        bucket.forEach((entry, index) => {
          const summary = entry.summary;
          const sessionStatus = statusOf(statuses, entry.sessionId);
          push({
            key: sessionKey(entry.sessionId),
            kind: 'sess',
            id: entry.sessionId,
            title: summaryTitle(summary) || entry.sessionId,
            path: typeof summary.cwd === 'string' ? summary.cwd : '',
            layer: entry.layer,
            rank: 1,
            ownerIndex: entry.ownerIndex,
            itemIndex: index,
            parentKey: entry.layoutParent,
            dim: false,
            counts: { sessions: 0, running: summary.running === true ? 1 : 0 },
            state: sessionState(sessionStatus, summary),
            pendingKind: pendingKindOf(sessionStatus),
            updatedAt: typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0,
            pinned: pinned.has(entry.sessionId),
            ref: summary,
          });
        });
      }

      if (showGroups) {
        groups.forEach((group, index) => {
          const members = (Array.isArray(group.sessionIds) ? group.sessionIds : []).filter((sessionId) => filtered(sessionId));
          let layer = 1;
          for (const sessionId of group.sessionIds) {
            const memberLayer = layerOfSession.get(sessionId);
            if (memberLayer !== undefined && memberLayer + 1 > layer) layer = memberLayer + 1;
          }
          const title = group.title || fallbackGroupTitle;
          push({
            key: containerKey('grp', group.id),
            kind: 'grp',
            id: group.id,
            title,
            path: commonDirectory(members, byId),
            layer: Math.min(MAX_LAYER, layer),
            rank: 2,
            ownerIndex: index,
            itemIndex: 0,
            parentKey: '',
            dim: searching && !matchesText(title) && members.length === 0,
            counts: { sessions: members.length, running: 0 },
            states: aggregateStates(group.sessionIds, byId, statuses, archivedForStates),
            updatedAt: latestActivity(members, byId),
            ref: group,
            memberIds: group.sessionIds,
          });
        });
      }

      if (unassignedIds.length > 0) {
        push({
          key: 'unassigned',
          kind: 'unassigned',
          id: '',
          title: unassignedTitle,
          path: '',
          layer: 0,
          rank: 3,
          ownerIndex: 0,
          itemIndex: 0,
          parentKey: '',
          dim: false,
          counts: { sessions: unassignedIds.length, running: 0 },
          states: aggregateStates(unassignedIds, byId, statuses, archivedForStates),
          updatedAt: latestActivity(unassignedIds, byId),
          ref: null,
          memberIds: unassignedIds,
        });
      }

      const nodeKeys = new Set(nodes.map((node) => node.key));
      const edges = [];
      const connect = (from, to, kind) => {
        if (!nodeKeys.has(from) || !nodeKeys.has(to)) return;
        edges.push({ from, to, kind });
      };
      for (const workspace of forest.list) {
        const parentId = forest.parentOf.get(workspace.workspaceId);
        if (parentId === '' || parentId === undefined) continue;
        connect(containerKey('ws', parentId), containerKey('ws', workspace.workspaceId), 'nest');
      }
      for (const sessionId of visibleSessions) {
        const workspaceId = ownerOf.get(sessionId);
        if (workspaceId === undefined) connect('unassigned', sessionKey(sessionId), 'unassigned');
        else connect(containerKey('ws', workspaceId), sessionKey(sessionId), 'member');
        const parentId = byId[sessionId]?.parentId;
        if (typeof parentId === 'string' && visibleSessions.has(parentId)) {
          connect(sessionKey(parentId), sessionKey(sessionId), 'fork');
        }
      }
      if (showGroups) {
        for (const group of groups) {
          for (const sessionId of group.sessionIds) {
            if (!visibleSessions.has(sessionId)) continue;
            connect(sessionKey(sessionId), containerKey('grp', group.id), 'group');
          }
        }
      }

      let filteredSessionCount = 0;
      for (const id of ids) {
        if (!filtered(id)) continue;
        const ownerId = ownerOf.get(id);
        if (respectHidden && ownerId !== undefined && hiddenWorkspaceIds.has(ownerId)) continue;
        filteredSessionCount += 1;
      }

      return {
        nodes,
        edges,
        unassignedCount: unassignedIds.length,
        stats: {
          workspaces: focusActive ? focusWsIds.size : Math.max(0, forest.list.length - (respectHidden ? hiddenWorkspaceCount : 0)),
          hiddenWorkspaces: hiddenWorkspaceCount,
          sessions: focusActive ? visibleSessions.size : filteredSessionCount,
          visibleSessions: visibleSessions.size,
          unassigned: unassignedIds.length,
          groups: showGroups ? groups.length : 0,
          edges: edges.length,
          states: aggregateStates(focusActive ? Array.from(visibleSessions) : ids, byId, statuses, archivedForStates),
          focused: focusActive,
        },
      };
    }

    /**
     * 节点排序：层 → 类别（工作区/会话/分组/未归入）→ 所属序号 → 项序号 → 键。
     * @param {object} left - 节点。
     * @param {object} right - 节点。
     * @returns {number} 比较结果。
     */
    function compareNodes(left, right) {
      if (left.layer !== right.layer) return left.layer - right.layer;
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.ownerIndex !== right.ownerIndex) return left.ownerIndex - right.ownerIndex;
      if (left.itemIndex !== right.itemIndex) return left.itemIndex - right.itemIndex;
      return String(left.key).localeCompare(String(right.key));
    }

    /**
     * 两个矩形是否重叠（按 `gap` 留白）。
     * @param {{x: number, y: number, w: number, h: number}} a - 矩形 A。
     * @param {{x: number, y: number, w: number, h: number}} b - 矩形 B。
     * @param {number} gap - 最小间距。
     * @returns {boolean} 是否算重叠。
     */
    function rectsOverlap(a, b, gap) {
      return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
    }

    /**
     * 给一个矩形找最近的空位：往下 / 往上 / 往右 / 往左各平移到不重叠，取位移最小的方向。
     * 每个方向都是单向扫描（不会来回跳），最多 64 次，正常布局一次就到底。
     * @param {{x: number, y: number, w: number, h: number}} box - 要挪的矩形。
     * @param {Array<{x: number, y: number, w: number, h: number}>} rects - 固定矩形。
     * @param {number} gap - 最小间距。
     * @returns {{dx: number, dy: number}} 位移。
     */
    function nearestFreeShift(box, rects, gap) {
      const hitsAt = (x, y) => {
        const probe = { x, y, w: box.w, h: box.h };
        const hits = [];
        for (const rect of rects) if (rectsOverlap(probe, rect, gap)) hits.push(rect);
        return hits;
      };
      /**
       * 沿一个轴单向扫到不重叠为止。
       * @param {'x'|'y'} axis - 轴。
       * @param {1|-1} direction - 正方向 / 负方向。
       * @returns {number|null} 位移（原点为 0）；扫不出去返回 null。
       */
      const scan = (axis, direction) => {
        const origin = axis === 'y' ? box.y : box.x;
        let value = origin;
        for (let guard = 0; guard < 64; guard += 1) {
          const hits = hitsAt(axis === 'y' ? box.x : value, axis === 'y' ? value : box.y);
          if (hits.length === 0) return value - origin;
          let next = direction > 0 ? -Infinity : Infinity;
          for (const rect of hits) {
            const edge =
              axis === 'y'
                ? direction > 0
                  ? rect.y + rect.h + gap
                  : rect.y - gap - box.h
                : direction > 0
                  ? rect.x + rect.w + gap
                  : rect.x - gap - box.w;
            next = direction > 0 ? Math.max(next, edge) : Math.min(next, edge);
          }
          if (!Number.isFinite(next)) return null;
          value = next;
        }
        return null;
      };
      const candidates = [
        { dx: 0, dy: scan('y', 1) },
        { dx: 0, dy: scan('y', -1) },
        { dx: scan('x', 1), dy: 0 },
        { dx: scan('x', -1), dy: 0 },
      ];
      let best = null;
      let bestDistance = Infinity;
      for (const candidate of candidates) {
        if (candidate.dx === null || candidate.dy === null) continue;
        const distance = Math.abs(candidate.dx) + Math.abs(candidate.dy);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      if (best !== null) return best;
      // 四个方向都被挤满（理论上不会）：整体挪到所有节点的最右侧，保证不重叠。
      let right = 0;
      for (const rect of rects) right = Math.max(right, rect.x + rect.w);
      return { dx: right + gap - box.x, dy: 0 };
    }

    /**
     * 手动拖出来的节点如果压在别的节点上，把「它 + 它的整棵子树」当刚体挪到最近的空位。
     * 只修正显示位置，不改 layout 里保存的坐标：拖动是用户意图，布局变化只是暂时的；
     * 下次布局回到不冲突的状态，节点会回到用户放的位置。
     * @param {object[]} nodes - 图节点（带 `parentKey`）。
     * @param {Record<string, {x: number, y: number, w: number, h: number}>} placed - 位置表（就地修正）。
     * @param {Record<string, {x?: number, y?: number}>} [saved] - 手动位置（layout.nodes）。
     * @returns {Record<string, {x: number, y: number, w: number, h: number}>} 位置表。
     */
    function separateManualNodes(nodes, placed, saved) {
      const list = Array.isArray(nodes) ? nodes : [];
      if (list.length === 0 || placed === null || placed === undefined || typeof placed !== 'object') return placed;
      const source = saved !== null && typeof saved === 'object' ? saved : {};
      const byKey = new Map();
      const childMap = new Map();
      for (const node of list) {
        byKey.set(node.key, node);
        const parentKey = typeof node.parentKey === 'string' ? node.parentKey : '';
        if (parentKey === '') continue;
        const bucket = childMap.get(parentKey);
        if (bucket === undefined) childMap.set(parentKey, [node.key]);
        else bucket.push(node.key);
      }
      const manual = new Set();
      for (const node of list) {
        const entry = source[node.key];
        if (entry === null || entry === undefined || typeof entry !== 'object') continue;
        if (Number.isFinite(entry.x) || Number.isFinite(entry.y)) manual.add(node.key);
      }
      if (manual.size === 0) return placed;
      // 父子都被手动拖过的节点是一个整体（拖容器会连子树一起写坐标），挪的时候一起挪。
      const rootOf = new Map();
      for (const key of manual) rootOf.set(key, key);
      const find = (key) => {
        let current = key;
        while (rootOf.has(current) && rootOf.get(current) !== current) current = rootOf.get(current);
        return current;
      };
      for (const key of manual) {
        const node = byKey.get(key);
        const parentKey = node !== undefined && typeof node.parentKey === 'string' ? node.parentKey : '';
        if (parentKey === '' || !manual.has(parentKey)) continue;
        const left = find(key);
        const right = find(parentKey);
        if (left !== right) rootOf.set(left, right);
      }
      const grouped = new Map();
      for (const key of manual) {
        const root = find(key);
        const bucket = grouped.get(root);
        if (bucket === undefined) grouped.set(root, [key]);
        else bucket.push(key);
      }
      const clusters = [];
      for (const keys of grouped.values()) {
        const members = new Set();
        const stack = keys.slice();
        while (stack.length > 0) {
          const key = stack.pop();
          if (members.has(key) || placed[key] === undefined) continue;
          members.add(key);
          for (const child of childMap.get(key) ?? []) stack.push(child);
        }
        clusters.push(Array.from(members));
      }
      const keyNode = (keys) => {
        let best = null;
        for (const key of keys) {
          const node = byKey.get(key);
          if (node === undefined) continue;
          if (best === null || compareNodes(node, best) < 0) best = node;
        }
        return best;
      };
      clusters.sort((left, right) => {
        const a = keyNode(left);
        const b = keyNode(right);
        if (a === null || b === null) return left.length - right.length;
        return compareNodes(a, b);
      });
      const inside = new Set();
      for (const keys of clusters) for (const key of keys) inside.add(key);
      const fixed = [];
      for (const node of list) {
        const rect = placed[node.key];
        if (rect !== undefined && !inside.has(node.key)) fixed.push(rect);
      }
      for (const keys of clusters) {
        const rects = [];
        for (const key of keys) if (placed[key] !== undefined) rects.push(placed[key]);
        if (rects.length === 0) continue;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const rect of rects) {
          minX = Math.min(minX, rect.x);
          minY = Math.min(minY, rect.y);
          maxX = Math.max(maxX, rect.x + rect.w);
          maxY = Math.max(maxY, rect.y + rect.h);
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) continue;
        const shift = nearestFreeShift({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, fixed, ROW_GAP);
        for (const key of keys) {
          const rect = placed[key];
          if (rect === undefined) continue;
          placed[key] = { x: rect.x + shift.dx, y: rect.y + shift.dy, w: rect.w, h: rect.h };
          fixed.push(placed[key]);
        }
      }
      return placed;
    }

    /**
     * 排位置：列 = 层深（列宽取该层最宽节点），纵向按**父子子树**排——
     * 每个容器的会话/子工作区紧贴它排成一块，父节点再居中到这块上，连线短、展开即见。
     * 手动位置优先；被拖的容器连它的子树一起偏移，压到别人身上时整块挪到最近的空位。
     * @param {object[]} nodes - 图节点（带 `parentKey`）。
     * @param {Record<string, {x: number, y: number}>} [saved] - 手动位置（layout.nodes）。
     * @param {{separate?: boolean}} [options] - `separate:false` 时不做重叠避让（拖动进行中用）。
     * @returns {Record<string, {x: number, y: number, w: number, h: number}>} 位置表。
     */
    function placeNodes(nodes, saved, options) {
      const list = Array.isArray(nodes) ? nodes : [];
      const byKey = new Map();
      for (const node of list) byKey.set(node.key, node);
      const childMap = new Map();
      const roots = [];
      for (const node of list) {
        const parentKey = typeof node.parentKey === 'string' && node.parentKey !== '' && byKey.has(node.parentKey) && node.parentKey !== node.key ? node.parentKey : '';
        if (parentKey === '') {
          roots.push(node);
          continue;
        }
        const bucket = childMap.get(parentKey);
        if (bucket === undefined) childMap.set(parentKey, [node]);
        else bucket.push(node);
      }
      roots.sort(compareNodes);
      for (const bucket of childMap.values()) bucket.sort(compareNodes);

      const layerWidth = new Map();
      for (const node of list) {
        const size = NODE_SIZE[node.kind] ?? NODE_SIZE.sess;
        layerWidth.set(node.layer, Math.max(layerWidth.get(node.layer) ?? 0, size.w));
      }
      const layers = Array.from(layerWidth.keys()).sort((left, right) => left - right);
      const xOf = new Map();
      let cursor = LAYOUT_MARGIN;
      for (const layer of layers) {
        xOf.set(layer, cursor);
        cursor += (layerWidth.get(layer) ?? 0) + COLUMN_PITCH_EXTRA;
      }

      const yOf = new Map();
      /**
       * 递归排一棵子树，返回它占用的高度。
       * @param {object} node - 子树根。
       * @param {number} top - 子树顶部的 y。
       * @returns {number} 子树高度。
       */
      const placeSubtree = (node, top) => {
        const size = NODE_SIZE[node.kind] ?? NODE_SIZE.sess;
        const children = childMap.get(node.key) ?? [];
        if (children.length === 0) {
          yOf.set(node.key, top);
          return size.h;
        }
        let childTop = top;
        let lastBottom = top;
        for (const child of children) {
          const childSize = NODE_SIZE[child.kind] ?? NODE_SIZE.sess;
          // 子节点自己可能还有一整棵子树（嵌套工作区 / fork 会话）：必须按它返回的
          // 真实高度往后退。只按子卡片高度退，下一个兄弟就会压到孙节点上——
          // 这就是「带子工作区的工作区被后面的卡片叠住」的根因。
          const childHeight = placeSubtree(child, childTop);
          lastBottom = childTop + Math.max(childHeight, childSize.h);
          childTop = lastBottom + ROW_GAP;
        }
        const blockBottom = lastBottom;
        // 父节点居中到子块上（不能高于子块顶部）。
        const centered = (top + blockBottom) / 2 - size.h / 2;
        yOf.set(node.key, Math.max(top, centered));
        return Math.max(blockBottom - top, size.h);
      };

      // 分组节点不属于任何子树：优先锚到它成员会话的右侧（连线短），再避让已有节点。
      const groupRoots = roots.filter((node) => node.kind === 'grp');
      const treeRoots = roots.filter((node) => node.kind !== 'grp');
      let yCursor = LAYOUT_MARGIN;
      for (const root of treeRoots) {
        const height = placeSubtree(root, yCursor);
        yCursor += height + ROW_GAP;
      }

      const xOverride = new Map();
      const rectOf = (node) => {
        const size = NODE_SIZE[node.kind] ?? NODE_SIZE.sess;
        return {
          x: xOf.get(node.layer) ?? LAYOUT_MARGIN,
          y: yOf.get(node.key) ?? LAYOUT_MARGIN,
          w: size.w,
          h: size.h,
        };
      };
      const overlaps = (a, b) =>
        a.x < b.x + b.w + ROW_GAP && b.x < a.x + a.w + ROW_GAP && a.y < b.y + b.h + ROW_GAP && b.y < a.y + a.h + ROW_GAP;
      const settled = list.filter((node) => node.kind !== 'grp').map(rectOf);
      for (const group of groupRoots) {
        const size = NODE_SIZE.grp;
        const memberKeys = (Array.isArray(group.memberIds) ? group.memberIds : [])
          .map((id) => sessionKey(id))
          .filter((key) => byKey.has(key) && yOf.has(key));
        let x = xOf.get(group.layer) ?? LAYOUT_MARGIN;
        let y = yCursor;
        if (memberKeys.length > 0) {
          let right = -Infinity;
          let center = 0;
          for (const key of memberKeys) {
            const rect = rectOf(byKey.get(key));
            right = Math.max(right, rect.x + rect.w);
            center += rect.y + rect.h / 2;
          }
          x = right + GROUP_GAP;
          y = center / memberKeys.length - size.h / 2;
        }
        let candidate = { x, y, w: size.w, h: size.h };
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const hit = settled.find((rect) => overlaps(candidate, rect));
          if (hit === undefined) break;
          candidate = { ...candidate, y: hit.y + hit.h + ROW_GAP };
        }
        xOverride.set(group.key, candidate.x);
        yOf.set(group.key, candidate.y);
        settled.push(candidate);
        yCursor = Math.max(yCursor, candidate.y + size.h + ROW_GAP);
      }

      // 自动位置：层深给列 x，子树排版给 y，分组用避让后的 override。
      const auto = {};
      for (const node of list) {
        const size = NODE_SIZE[node.kind] ?? NODE_SIZE.sess;
        auto[node.key] = {
          x: xOverride.has(node.key) ? xOverride.get(node.key) : xOf.get(node.layer) ?? LAYOUT_MARGIN,
          y: yOf.get(node.key) ?? LAYOUT_MARGIN,
          w: size.w,
          h: size.h,
        };
      }

      // 手动位置只落在被拖的那个节点上；它的子孙如果没被单独拖过就继承父节点的偏移。
      // 否则把容器拖到别处再展开，会话会落回自动排布的位置——看起来像节点跑丢了。
      const manualOf = (key) => {
        const entry = saved === null || saved === undefined ? undefined : saved[key];
        if (entry === null || entry === undefined || typeof entry !== 'object') return null;
        const x = Number.isFinite(entry.x) ? entry.x : null;
        const y = Number.isFinite(entry.y) ? entry.y : null;
        if (x === null && y === null) return null;
        return { x, y };
      };
      const deltaOf = new Map();
      const resolveDelta = (key, depth) => {
        if (deltaOf.has(key)) return deltaOf.get(key);
        const node = byKey.get(key);
        const base = auto[key];
        if (node === undefined || base === undefined || depth > 64) return { dx: 0, dy: 0 };
        const own = manualOf(key);
        const parentKey = typeof node.parentKey === 'string' ? node.parentKey : '';
        const inherited =
          parentKey !== '' && byKey.has(parentKey) ? resolveDelta(parentKey, depth + 1) : { dx: 0, dy: 0 };
        const delta = {
          dx: own !== null && own.x !== null ? own.x - base.x : inherited.dx,
          dy: own !== null && own.y !== null ? own.y - base.y : inherited.dy,
        };
        deltaOf.set(key, delta);
        return delta;
      };
      const placed = {};
      for (const node of list) {
        const base = auto[node.key];
        const delta = resolveDelta(node.key, 0);
        placed[node.key] = { x: base.x + delta.dx, y: base.y + delta.dy, w: base.w, h: base.h };
      }
      // 手动拖出来的节点压在别人身上时整块挪到最近的空位（拖动进行中除外，保证跟手）。
      if (options === null || options === undefined || options.separate !== false) {
        separateManualNodes(list, placed, saved);
      }
      return placed;
    }

    /**
     * 一条贝塞尔连线的 `d`。
     * @param {{x: number, y: number, w: number, h: number}} from - 起点矩形。
     * @param {{x: number, y: number, w: number, h: number}} to - 终点矩形。
     * @param {number} [yOffset] - 起点纵向错位（同源扇出）。
     * @returns {string} SVG path。
     */
    function edgePath(from, to, yOffset = 0) {
      const round = (value) => Math.round(value * 10) / 10;
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2 + yOffset;
      const x2 = to.x;
      const y2 = to.y + to.h / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) / 2);
      return `M ${round(x1)} ${round(y1)} C ${round(x1 + dx)} ${round(y1)}, ${round(x2 - dx)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
    }

    /**
     * 把连线转成 path（同源节点做扇形错位，减少重叠）。
     * @param {object[]} edges - 图连线。
     * @param {Record<string, {x: number, y: number, w: number, h: number}>} placed - 位置表。
     * @returns {Array<{key: string, kind: string, d: string}>} path 列表。
     */
    function buildEdgePaths(edges, placed) {
      const totals = new Map();
      for (const edge of Array.isArray(edges) ? edges : []) {
        totals.set(edge.from, (totals.get(edge.from) ?? 0) + 1);
      }
      const seen = new Map();
      const out = [];
      for (const edge of Array.isArray(edges) ? edges : []) {
        const from = placed[edge.from];
        const to = placed[edge.to];
        if (from === undefined || to === undefined) continue;
        const total = totals.get(edge.from) ?? 1;
        const index = seen.get(edge.from) ?? 0;
        seen.set(edge.from, index + 1);
        const offset = total <= 1 ? 0 : Math.max(-36, Math.min(36, (index - (total - 1) / 2) * 12));
        out.push({ key: `${edge.from}->${edge.to}:${edge.kind}`, kind: edge.kind, d: edgePath(from, to, offset) });
      }
      return out;
    }

    /**
     * 可见节点的世界包围盒。
     * @param {Record<string, {x: number, y: number, w: number, h: number}>} placed - 位置表。
     * @returns {{minX: number, minY: number, width: number, height: number}} 包围盒。
     */
    function worldBounds(placed) {
      const keys = Object.keys(placed ?? {});
      if (keys.length === 0) return { minX: 0, minY: 0, width: 800, height: 600 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const key of keys) {
        const rect = placed[key];
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.w);
        maxY = Math.max(maxY, rect.y + rect.h);
      }
      return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    }

    /**
     * 缩放夹取。
     * @param {unknown} value - 原始倍率。
     * @returns {number} 倍率。
     */
    function clampZoom(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return 1;
      return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, number));
    }

    /**
     * 屏幕坐标 → 世界坐标。
     * @param {{x: number, y: number}} point - 画布内坐标。
     * @param {{x: number, y: number, zoom: number}} viewport - 视口。
     * @returns {{x: number, y: number}} 世界坐标。
     */
    function screenToWorld(point, viewport) {
      return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
    }

    /**
     * 世界坐标 → 屏幕坐标。
     * @param {{x: number, y: number}} point - 世界坐标。
     * @param {{x: number, y: number, zoom: number}} viewport - 视口。
     * @returns {{x: number, y: number}} 画布内坐标。
     */
    function worldToScreen(point, viewport) {
      return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
    }

    /**
     * 适应窗口：把全部可见节点放进画布。
     * @param {Record<string, {x: number, y: number, w: number, h: number}>} placed - 位置表。
     * @param {{w: number, h: number}} size - 画布尺寸。
     * @returns {{x: number, y: number, zoom: number}} 视口。
     */
    function fitViewport(placed, size) {
      const bounds = worldBounds(placed);
      const width = size !== null && size !== undefined && Number.isFinite(size.w) ? size.w : 0;
      const height = size !== null && size !== undefined && Number.isFinite(size.h) ? size.h : 0;
      if (width <= 0 || height <= 0) return { x: 60, y: 60, zoom: 1 };
      const zoom = clampZoom(Math.min((width - 80) / bounds.width, (height - 80) / bounds.height, 1.2));
      return {
        x: (width - bounds.width * zoom) / 2 - bounds.minX * zoom,
        y: (height - bounds.height * zoom) / 2 - bounds.minY * zoom,
        zoom,
      };
    }

    /**
     * 展开/收起后的视口：让被点的容器**留在屏幕原位**（缩放也不变），
     * 展开时新出现的子树如果不在视野里，再把它最小平移进来；
     * 子树比视口还大时不做整体平移（保留锚点，别把卡片推出屏幕）。
     * 这就是「视图跟随工作区位置」：布局重排多少，视口就补偿多少。
     * @param {{x: number, y: number}} anchor - 操作前容器左上角在画布内的屏幕坐标。
     * @param {{x: number, y: number, w: number, h: number}} rect - 操作后容器矩形（世界坐标）。
     * @param {Array<{x: number, y: number, w: number, h: number}>} subtree - 操作后要露出来的矩形（容器 + 子树）。
     * @param {{w: number, h: number}} size - 画布尺寸。
     * @param {number} zoom - 缩放倍率（保持不变）。
     * @returns {{x: number, y: number, zoom: number}} 新视口。
     */
    function followViewport(anchor, rect, subtree, size, zoom) {
      const scale = clampZoom(zoom);
      const anchorX = anchor !== null && anchor !== undefined && Number.isFinite(anchor.x) ? anchor.x : 0;
      const anchorY = anchor !== null && anchor !== undefined && Number.isFinite(anchor.y) ? anchor.y : 0;
      const rectX = rect !== null && rect !== undefined && Number.isFinite(rect.x) ? rect.x : 0;
      const rectY = rect !== null && rect !== undefined && Number.isFinite(rect.y) ? rect.y : 0;
      let x = anchorX - rectX * scale;
      let y = anchorY - rectY * scale;
      const width = size !== null && size !== undefined && Number.isFinite(size.w) ? size.w : 0;
      const height = size !== null && size !== undefined && Number.isFinite(size.h) ? size.h : 0;
      if (width <= 0 || height <= 0) return { x, y, zoom: scale };
      const boxes = (Array.isArray(subtree) ? subtree : []).filter(
        (item) =>
          item !== null &&
          item !== undefined &&
          Number.isFinite(item.x) &&
          Number.isFinite(item.y) &&
          Number.isFinite(item.w) &&
          Number.isFinite(item.h),
      );
      if (boxes.length === 0) return { x, y, zoom: scale };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const box of boxes) {
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.w);
        maxY = Math.max(maxY, box.y + box.h);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x, y, zoom: scale };
      const pad = 32;
      const left = minX * scale + x;
      const top = minY * scale + y;
      const right = maxX * scale + x;
      const bottom = maxY * scale + y;
      // 放得下就只做最小平移；放不下（子树比视野还大）就保持锚点不动，
      // 别为了露全把被点的卡片推出屏幕——那种情况让用户自己缩/拖。
      if (right - left <= width - pad * 2) {
        if (left < pad) x += pad - left;
        else if (right > width - pad) x += width - pad - right;
      }
      if (bottom - top <= height - pad * 2) {
        if (top < pad) y += pad - top;
        else if (bottom > height - pad) y += height - pad - bottom;
      }
      return { x, y, zoom: scale };
    }

    /**
     * 当前视口里是否至少有一个节点可见（用来识别「视口漂到空白区」并自动适应）。
     * @param {Record<string, {x: number, y: number, w: number, h: number}>} placed - 位置表。
     * @param {{x: number, y: number, zoom: number}} viewport - 视口。
     * @param {{w: number, h: number}} size - 画布尺寸。
     * @returns {boolean} 是否可见。
     */
    function anyNodeVisible(placed, viewport, size) {
      if (viewport === null || viewport === undefined || !Number.isFinite(viewport.zoom)) return false;
      const width = size !== null && size !== undefined && Number.isFinite(size.w) ? size.w : 0;
      const height = size !== null && size !== undefined && Number.isFinite(size.h) ? size.h : 0;
      if (width <= 0 || height <= 0) return false;
      for (const key of Object.keys(placed ?? {})) {
        const rect = placed[key];
        const left = rect.x * viewport.zoom + viewport.x;
        const top = rect.y * viewport.zoom + viewport.y;
        const right = left + rect.w * viewport.zoom;
        const bottom = top + rect.h * viewport.zoom;
        if (right > 0 && bottom > 0 && left < width && top < height) return true;
      }
      return false;
    }

    /**
     * 规范化布局（Host 也有一份同样的规则；这里是渲染前的兜底）。
     * 只记展开态、没有手动位置的条目必须保留，否则「展开/收起」刷新后就丢了。
     * @param {unknown} input - `{nodes}` 或直接 nodes。
     * @returns {{nodes: Record<string, {x?: number, y?: number, expanded?: boolean}>}} 布局。
     */
    function normalizeLayout(input) {
      const source =
        input !== null && typeof input === 'object' && input.nodes !== null && typeof input.nodes === 'object'
          ? input.nodes
          : input !== null && typeof input === 'object'
            ? input
            : {};
      const nodes = {};
      let count = 0;
      for (const key of Object.keys(source)) {
        if (count >= LIMITS.maxLayoutNodes) break;
        const value = source[key];
        if (!LAYOUT_KEY.test(key) || value === null || typeof value !== 'object') continue;
        const x = Number(value.x);
        const y = Number(value.y);
        const hasX = Number.isFinite(x);
        const hasY = Number.isFinite(y);
        const hasExpanded = value.expanded === true || value.expanded === false;
        if (!hasX && !hasY && !hasExpanded) continue;
        const entry = {};
        if (hasX) entry.x = Math.min(LIMITS.maxCoord, Math.max(-LIMITS.maxCoord, x));
        if (hasY) entry.y = Math.min(LIMITS.maxCoord, Math.max(-LIMITS.maxCoord, y));
        if (hasExpanded) entry.expanded = value.expanded === true;
        nodes[key] = entry;
        count += 1;
      }
      return { nodes };
    }

    /**
     * 读本机保存的视口（坏值返回 null）。
     * @returns {{x: number, y: number, zoom: number}|null} 视口。
     */
    function loadViewport() {
      const raw = readJson(LS_VIEWPORT);
      if (raw === null || typeof raw !== 'object') return null;
      const x = Number(raw.x);
      const y = Number(raw.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y, zoom: clampZoom(raw.zoom) };
    }

    /**
     * 面板错误边界：组件一旦抛错，显示可读错误和「重试」，而不是把页面留成空白。
     * @param {Function} t - 翻译函数。
     * @returns {Function} 错误边界类组件。
     */
    function makeBoundary(t) {
      return class PanelBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }

        static getDerivedStateFromError(error) {
          return { error };
        }

        componentDidCatch(error, info) {
          try {
            console.error('[workspace-graph] panel crashed', error, info);
          } catch {
            /* ignore */
          }
        }

        render() {
          if (this.state.error === null) return this.props.children;
          return h(
            'div',
            { className: 'wg2-root' },
            h(
              'div',
              { className: 'wg2-status wg2-status-err', style: { margin: 24 }, role: 'alert' },
              t('msg.crashed', { msg: messageOf(this.state.error) }),
            ),
            h(
              'div',
              { style: { padding: '0 24px' } },
              h(Btn, { variant: 'primary', onClick: () => this.setState({ error: null }) }, t('action.retry')),
            ),
          );
        }
      };
    }

    /**
     * 造主面板组件（闭包持有 ctx / t，以及只建一次的请求辅助函数）。
     *
     * @param {object} ctx - 客户端根上下文。
     * @param {Function} t - 翻译函数。
     * @returns {Function} 面板组件。
     */
    function makePanel(ctx, t) {
      /**
       * 取可选客户端服务。
       * @param {string} name - 服务名。
       * @returns {object|undefined} 服务。
       */
      function serviceOf(name) {
        try {
          return ctx.get === undefined ? undefined : ctx.get(name);
        } catch {
          return undefined;
        }
      }

      /**
       * 在侧栏的工作区面板里找某个工作区的分组行。
       *
       * @param {string} workspaceId - 工作区 id。
       * @returns {Element|null} 行元素；侧栏未挂载、或该行被折叠的祖先分组藏住时是 null。
       */
      function workspaceRowOf(workspaceId) {
        if (typeof document === 'undefined') return null;
        const key = `workspace:${workspaceId}`;
        const rows = document.querySelectorAll('[data-row-key]');
        for (const row of rows) {
          if (typeof row.getAttribute === 'function' && row.getAttribute('data-row-key') === key) return row;
        }
        return null;
      }

      /**
       * 目标工作区在侧栏树形分组里的祖先链（由外到内）。
       *
       * 侧栏按目录嵌套把子工作区分组收进父工作区分组，父分组被折叠时子行根本不渲染；
       * 这里复刻它自己的规则：取「最长路径前缀」的已登记祖先，逐层往上。
       *
       * @param {string} workspaceId - 目标工作区 id。
       * @returns {string[]} 祖先 id；取不到工作区列表时为空数组。
       */
      function workspaceAncestorIdsOf(workspaceId) {
        const service = serviceOf('workspaces');
        const list = service === undefined ? undefined : service.list;
        if (list === undefined || typeof list.getSnapshot !== 'function') return [];
        let snapshot;
        try {
          snapshot = list.getSnapshot();
        } catch {
          return [];
        }
        const items = snapshot === undefined || !Array.isArray(snapshot.items) ? [] : snapshot.items;
        const own = items.find((item) => item !== null && typeof item === 'object' && item.workspaceId === workspaceId);
        if (own === undefined) return [];
        const chain = [];
        const seen = new Set([workspaceId]);
        let cursor = pathParentOf(own, items);
        while (
          cursor !== null
          && cursor !== undefined
          && typeof cursor.workspaceId === 'string'
          && !seen.has(cursor.workspaceId)
          && chain.length < MAX_LAYER
        ) {
          chain.push(cursor.workspaceId);
          seen.add(cursor.workspaceId);
          cursor = pathParentOf(cursor, items);
        }
        return chain.reverse();
      }

      /**
       * 尽力让侧栏工作区面板「定位到」某个工作区：展开它的分组（含折叠着的祖先分组），
       * 再把行滚进可见区。
       *
       * 侧栏的工作区面板（ui-workspace 的 WorkspaceBrowser）没有公开的 reveal 接口，
       * 只有搜索命中时才会自己把行滚动到可见。这里用两条稳定但内部的通路：
       *   ① 该 Client 服务构造时把浏览器的视图写集存成 `service.view`，其中
       *      `setGroupExpanded(key, expanded)` 与用户点开分组等价（分组 key 就是 workspaceId）；
       *   ② 分组行 DOM 带 `data-row-key="workspace:<id>"`，`aria-expanded` 反映展开状态，
       *      最后用 `scrollIntoView` 滚进可见区——和侧栏自己的 reveal 是同一手法。
       * 树形分组下目标行可能被折叠的祖先藏住（DOM 里根本没有该行）：按祖先链逐层展开后再找。
       * 打开工作区会新建/复用空白会话并重渲染侧栏，分组行可能晚一拍出现，所以按帧重试到超时。
       * 侧栏被收起、或当前处于搜索视图时行不存在：只写展开偏好，不强行改变侧栏开合。
       *
       * @param {string} workspaceId - 目标工作区 id。
       */
      function revealWorkspaceInSidebar(workspaceId) {
        const service = serviceOf('uiWorkspace');
        const view = service === undefined ? undefined : service.view;
        // 视图写集可用时用它展开；不可用（老版本）才退回点行。
        const expand = (key) => {
          if (view === undefined || typeof view.setGroupExpanded !== 'function') return false;
          try {
            view.setGroupExpanded(key, true);
            return true;
          } catch {
            // 侧栏没挂载时视图写集可能拒绝；定位失败不影响「打开」本身。
            return false;
          }
        };
        const expandedByView = expand(workspaceId);
        const clicked = new Set();
        // 树形分组下祖先被折叠时，目标行不在 DOM 里：把「看得见的、还折叠着的」祖先逐层展开。
        const revealCollapsedAncestor = () => {
          for (const ancestorId of workspaceAncestorIdsOf(workspaceId)) {
            const row = workspaceRowOf(ancestorId);
            if (row === null) continue;
            if (row.getAttribute('aria-expanded') !== 'false') continue;
            if (expand(ancestorId)) return true;
            if (clicked.has(ancestorId)) return false;
            clicked.add(ancestorId);
            row.click();
            return true;
          }
          return false;
        };
        const deadline = Date.now() + SIDEBAR_REVEAL_MS;
        const soon = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
        const step = () => {
          const row = workspaceRowOf(workspaceId);
          if (row !== null) {
            // 视图写集能用时展开已经生效，绝不再点行——点一下会把刚展开的分组折叠回去；
            // 只有写集不可用（老版本 / 没有 view）才退回点行，并以 aria-expanded 为准。
            if (!expandedByView && row.getAttribute('aria-expanded') === 'false' && !clicked.has(workspaceId)) {
              clicked.add(workspaceId);
              row.click();
            }
            scrollWorkspaceRowIntoView(row);
            return;
          }
          if (Date.now() >= deadline) return;
          revealCollapsedAncestor();
          soon(step);
        };
        soon(step);
      }

      /**
       * 把侧栏分组行滚到它所在滚动区的偏上位置（导航后一眼能看到该工作区及下面的会话）。
       *
       * `scrollIntoView({block:'nearest'})` 只保证「可见」，行可能停在面板底部；
       * 这里找到侧栏列表自己的滚动容器，显式算 scrollTop，让行落在上方约 1/6 处。
       *
       * @param {Element} row - 分组行。
       */
      function scrollWorkspaceRowIntoView(row) {
        const reduce = typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const behavior = reduce ? 'auto' : 'smooth';
        // 往上找第一个真正可滚的祖先：侧栏列表容器。
        let scroller = row.parentElement;
        while (scroller !== null) {
          const style = typeof getComputedStyle === 'function' ? getComputedStyle(scroller) : undefined;
          const overflowY = style === undefined ? '' : style.overflowY;
          const scrollable = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
            && scroller.scrollHeight > scroller.clientHeight + 1;
          if (scrollable) break;
          scroller = scroller.parentElement;
        }
        if (scroller === null) {
          // 没有独立滚动容器（或拿不到）：退回原生定位，至少保证在视口里。
          try {
            row.scrollIntoView({ block: 'center', behavior });
          } catch {
            row.scrollIntoView();
          }
          return;
        }
        const rowBox = row.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        const offset = Math.round(Math.min(96, Math.max(12, box.height * 0.16)));
        const top = scroller.scrollTop + (rowBox.top - box.top) - offset;
        try {
          scroller.scrollTo({ top, behavior });
        } catch {
          scroller.scrollTop = top;
        }
      }

      /**
       * 发一个 JSON 请求；非 2xx 抛带可读 message 的错误。
       * @param {string} url - 地址。
       * @param {object} [init] - fetch 选项。
       * @returns {Promise<object>} 响应体。
       */
      async function requestJson(url, init) {
        const response = await fetch(url, init);
        let body = {};
        try {
          const text = await response.text();
          body = text === '' ? {} : JSON.parse(text);
        } catch {
          body = {};
        }
        if (response.ok !== true) {
          const message = typeof body.message === 'string' ? body.message : t('msg.http', { status: response.status });
          const error = new Error(message);
          error.code = typeof body.code === 'string' ? body.code : '';
          throw error;
        }
        return body;
      }

      /**
       * POST JSON。
       * @param {string} url - 地址。
       * @param {unknown} value - 请求体。
       * @returns {Promise<object>} 响应体。
       */
      function postJson(url, value) {
        return requestJson(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        });
      }

      return function WorkspaceGraphPanel(props) {
        const P = props === null || props === undefined ? {} : props;
        const [, forceRender] = React.useState(0);
        // 视口跟随必须在浏览器绘制前生效，不然会先闪一帧「跳过去再跳回来」。
        const useSyncEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

        // 标准 props 的 hooks 必须无条件调用；缺失时用稳定空实现兜住，顺序不会变。
        const useWorkspaces = typeof P.useWorkspaces === 'function' ? P.useWorkspaces : noSnapshot;
        const useSessions = typeof P.useSessions === 'function' ? P.useSessions : noSnapshot;
        const useSessionStatus = typeof P.useSessionStatus === 'function' ? P.useSessionStatus : noSnapshot;
        const workspaceSnapshot = useWorkspaces(identity);
        const sessionList = useSessions(identity);
        const sessionStatuses = useSessionStatus(identity);

        const prefs = React.useRef(null);
        if (prefs.current === null) prefs.current = loadUi();
        const canvasRef = React.useRef(null);
        const savedViewport = React.useRef(loadViewport());
        const layoutRef = React.useRef({});
        const viewportRef = React.useRef({ x: 60, y: 60, zoom: 1 });
        const dragRef = React.useRef(null);
        const panRef = React.useRef(null);
        const saveTimer = React.useRef(0);
        const fittedRef = React.useRef(false);
        const placedRef = React.useRef({});
        const filterFitRef = React.useRef({ focusActive: prefs.current.focusActive === true, query: '' });
        const pendingFilterFitRef = React.useRef(false);

        const [groups, setGroups] = React.useState([]);
        const [layoutNodes, setLayoutNodes] = React.useState({});
        const [groupsPhase, setGroupsPhase] = React.useState('loading');
        const [viewport, setViewport] = React.useState(() => savedViewport.current ?? { x: 60, y: 60, zoom: 1 });
        const [size, setSize] = React.useState({ w: 0, h: 0 });
        const [query, setQuery] = React.useState('');
        const [showArchived, setShowArchived] = React.useState(prefs.current.showArchived === true);
        const [showSubagent, setShowSubagent] = React.useState(prefs.current.showSubagent === true);
        const [showGroups, setShowGroups] = React.useState(prefs.current.showGroups !== false);
        const [focusActive, setFocusActive] = React.useState(prefs.current.focusActive === true);
        const [showHidden, setShowHidden] = React.useState(prefs.current.showHidden === true);
        const [tishiHiddenIds, setTishiHiddenIds] = React.useState(() =>
          typeof window === 'undefined' ? new Set() : readTishiHiddenWorkspaceIds(window.localStorage),
        );
        const [selection, setSelection] = React.useState(emptySelection);
        const [dialog, setDialog] = React.useState(null);
        const [followRequest, setFollowRequest] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [status, setStatus] = React.useState({ kind: 'idle', text: '' });
        const [details, setDetails] = React.useState([]);
        const [renaming, setRenaming] = React.useState(null);
        const [confirmDeleteWs, setConfirmDeleteWs] = React.useState('');
        const [confirmDeleteGrp, setConfirmDeleteGrp] = React.useState('');

        layoutRef.current = layoutNodes;
        viewportRef.current = viewport;

        React.useEffect(() => {
          const locale = ctx.locale;
          if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
          return locale.subscribe(() => forceRender((value) => value + 1));
        }, []);

        // 「3 分钟前」这类相对时间要跟着走：每分钟重渲染一次（只在浏览器里，测试桩不跑 effect）。
        React.useEffect(() => {
          if (typeof setInterval !== 'function') return undefined;
          const timer = setInterval(() => forceRender((value) => value + 1), 60 * 1000);
          return () => clearInterval(timer);
        }, []);

        // dsh_tishi 的隐藏集合可能在别的面板里改；同页写 localStorage 不触发 storage 事件，只能轮询。
        React.useEffect(() => {
          if (typeof setInterval !== 'function' || typeof window === 'undefined') return undefined;
          const timer = setInterval(() => {
            const next = readTishiHiddenWorkspaceIds(window.localStorage);
            setTishiHiddenIds((previous) => (sameIdSet(previous, next) ? previous : next));
          }, 1500);
          return () => clearInterval(timer);
        }, []);

        React.useEffect(() => {
          writeJson(LS_UI, { version: 4, showArchived, showSubagent, showGroups, focusActive, showHidden });
        }, [showArchived, showSubagent, showGroups, focusActive, showHidden]);

        React.useEffect(() => {
          writeJson(LS_VIEWPORT, { x: Math.round(viewport.x), y: Math.round(viewport.y), zoom: viewport.zoom });
        }, [viewport]);

        React.useEffect(() => {
          void loadState();
        }, []);

        React.useEffect(() => {
          const element = canvasRef.current;
          if (element === null || element === undefined) return undefined;
          const update = () => setSize({ w: element.clientWidth, h: element.clientHeight });
          update();
          if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(update);
            observer.observe(element);
            return () => observer.disconnect();
          }
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
          }
          return undefined;
        }, []);

        React.useEffect(() => {
          const element = canvasRef.current;
          if (element === null || element === undefined || typeof element.addEventListener !== 'function') return undefined;
          const onWheel = (event) => {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : { left: 0, top: 0 };
            const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            const current = viewportRef.current;
            const factor = Math.exp(-event.deltaY * 0.0015);
            const zoom = clampZoom(current.zoom * factor);
            const world = screenToWorld(point, current);
            setViewport({ zoom, x: point.x - world.x * zoom, y: point.y - world.y * zoom });
          };
          element.addEventListener('wheel', onWheel, { passive: false });
          return () => element.removeEventListener('wheel', onWheel);
        }, []);

        React.useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
          const onKey = (event) => {
            if (event.key !== 'Escape') return;
            if (dialog !== null) setDialog(null);
            else setSelection(emptySelection());
          };
          document.addEventListener('keydown', onKey);
          return () => document.removeEventListener('keydown', onKey);
        }, [dialog]);

        React.useEffect(
          () => () => {
            if (saveTimer.current !== 0 && typeof saveTimer.current !== 'undefined') {
              try {
                clearTimeout(saveTimer.current);
              } catch {
                /* ignore */
              }
              void saveLayoutNow();
            }
          },
          [],
        );

        // ---------------------------------------------------------- 数据切片

        const workspaces = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : [];
        const hiddenWorkspaceCount = workspaces.reduce(
          (count, workspace) => (tishiHiddenIds.has(workspace.workspaceId) ? count + 1 : count),
          0,
        );
        const list = sessionList !== null && typeof sessionList === 'object' ? sessionList : null;
        const byId = list?.byId ?? {};
        const archivedIds = new Set(
          Array.isArray(workspaceSnapshot?.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : [],
        );
        const pinnedIds = new Set(Array.isArray(workspaceSnapshot?.pinnedSessionIds) ? workspaceSnapshot.pinnedSessionIds : []);
        const options = { showArchived, showSubagent, archivedIds };
        const degraded = list === null || workspaceSnapshot === null;
        const expanded = new Set(
          Object.keys(layoutNodes).filter((key) => layoutNodes[key] !== undefined && layoutNodes[key].expanded === true),
        );
        const graph = degraded
          ? { nodes: [], edges: [], stats: { workspaces: 0, sessions: 0, unassigned: 0, groups: 0, edges: 0, states: { pending: 0, running: 0, done: 0 } }, unassignedCount: 0 }
          : buildGraph({
              workspaces,
              groups,
              list,
              options,
              expanded,
              showGroups,
              focusActive,
              showHidden,
              hiddenWorkspaceIds: tishiHiddenIds,
              query,
              pinnedIds,
              statuses: sessionStatuses,
              groupFallbackTitle: t('group.untitled'),
              unassignedTitle: t('section.unassigned'),
            });
        // 拖动进行中不做重叠避让：节点要跟手；松手后再整块挪开（onCanvasPointerUp 触发重渲染）。
        const placed = placeNodes(graph.nodes, layoutNodes, { separate: dragRef.current === null });
        placedRef.current = placed;
        const edgePaths = buildEdgePaths(graph.edges, placed);
        const bounds = worldBounds(placed);
        const sel = { sessions: selection.sessions.size, workspaces: selection.workspaces.size, groups: selection.groups.size };
        const selectionTotal = sel.sessions + sel.workspaces + sel.groups;
        const unassignedRowsCache = degraded ? [] : unassignedRows(list, workspaces, options);

        // ---------------------------------------------------------- 状态辅助

        const say = (kind, text) => setStatus({ kind, text });
        const clearStatus = () => {
          setStatus({ kind: 'idle', text: '' });
          setDetails([]);
        };
        const failStatus = (key, error) => say('err', t(key, { msg: messageOf(error) }));

        /**
         * 时间结构转文案。
         * @param {{kind: string, n?: number, time?: string, date?: string}|null} parts - 结构。
         * @returns {string} 文案。
         */
        function timeTextOf(parts) {
          if (parts === null) return '';
          return t(`time.${parts.kind}`, parts);
        }

        /**
         * 找一个工作区视图。
         * @param {string} id - 工作区 id。
         * @returns {object|undefined} WorkspaceView。
         */
        function workspaceById(id) {
          return workspaces.find((workspace) => workspace.workspaceId === id);
        }

        /**
         * 找一个分组。
         * @param {string} id - 分组 id。
         * @returns {object|undefined} 分组。
         */
        function groupById(id) {
          return groups.find((group) => group.id === id);
        }

        /**
         * 会话是否已展开的容器里（决定节点可见性的同一规则，供面板统计复用）。
         * @param {object} node - 图节点。
         * @returns {boolean} 是否被选中。
         */
        function nodeSelected(node) {
          if (node.kind === 'ws') return selection.workspaces.has(node.id);
          if (node.kind === 'grp') return selection.groups.has(node.id);
          if (node.kind === 'sess') return selection.sessions.has(node.id);
          return false;
        }

        /**
         * 单击节点：普通点击单选，Ctrl/Cmd/Shift 追加。
         * @param {object} node - 图节点。
         * @param {boolean} additive - 是否追加。
         */
        function selectNode(node, additive) {
          if (node.kind === 'unassigned') {
            if (additive !== true) setSelection(emptySelection());
            return;
          }
          const bucket = node.kind === 'ws' ? 'workspaces' : node.kind === 'grp' ? 'groups' : 'sessions';
          setSelection((prev) => {
            if (additive === true) return toggleIn(prev, bucket, node.id);
            const next = emptySelection();
            next[bucket].add(node.id);
            return next;
          });
        }

        /**
         * 切换容器展开态（持久化在 layout 里）。
         * @param {string} key - 容器键。
         */
        function toggleExpanded(key) {
          const current = layoutRef.current;
          const entry = current[key] ?? {};
          const expanding = entry.expanded !== true;
          // 记下点之前容器在屏幕上的位置：布局重排后把视口补偿回来，让它原地不动。
          const before = placedRef.current[key];
          const anchor =
            before === undefined || before === null
              ? null
              : worldToScreen({ x: before.x, y: before.y }, viewportRef.current);
          const next = { ...current, [key]: { ...entry, expanded: expanding } };
          layoutRef.current = next;
          setLayoutNodes(next);
          saveLayoutSoon();
          if (anchor === null) setFollowRequest(null);
          else setFollowRequest({ key, anchor, zoom: viewportRef.current.zoom, expanding, nonce: Date.now() });
        }

        /** 展开全部容器。 */
        function expandAll() {
          const next = { ...layoutRef.current };
          for (const node of graph.nodes) {
            if (node.kind === 'sess') continue;
            next[node.key] = { ...(next[node.key] ?? {}), expanded: true };
          }
          layoutRef.current = next;
          setLayoutNodes(next);
          saveLayoutSoon();
        }

        /** 收起全部容器。 */
        function collapseAll() {
          const next = {};
          for (const key of Object.keys(layoutRef.current)) next[key] = { ...layoutRef.current[key], expanded: false };
          layoutRef.current = next;
          setLayoutNodes(next);
          saveLayoutSoon();
        }

        /** 尽快保存布局（拖动结束/展开切换后 400ms）。 */
        function saveLayoutSoon() {
          if (typeof clearTimeout === 'function') clearTimeout(saveTimer.current);
          if (typeof setTimeout !== 'function') return;
          saveTimer.current = setTimeout(() => {
            void saveLayoutNow();
          }, 400);
        }

        /** 立刻保存布局；失败只提示，不回滚本地位置。 */
        async function saveLayoutNow() {
          try {
            await postJson(ROUTES.layout, { nodes: layoutRef.current });
          } catch (error) {
            failStatus('msg.layoutFailed', error);
          }
        }

        /** 从 Host 重新读分组 + 布局。 */
        async function loadState() {
          setGroupsPhase('loading');
          try {
            const body = await requestJson(ROUTES.state, { method: 'GET' });
            setGroups(normalizeGroups(body?.groups));
            const layout = normalizeLayout(body?.layout);
            setLayoutNodes(layout.nodes);
            layoutRef.current = layout.nodes;
            setGroupsPhase('ready');
          } catch (error) {
            setGroupsPhase('error');
            failStatus('msg.groupsFailed', error);
          }
        }

        /**
         * 整表保存分组；响应是事实来源，布局不受影响。
         * @param {object[]} next - 新分组数组。
         * @param {string} successText - 成功提示。
         * @returns {Promise<boolean>} 是否成功。
         */
        async function persistGroups(next, successText) {
          setBusy(true);
          try {
            const body = await postJson(ROUTES.groups, { version: 1, groups: next });
            setGroups(normalizeGroups(body?.groups));
            setGroupsPhase('ready');
            say('ok', successText);
            return true;
          } catch (error) {
            failStatus('msg.saveFailed', error);
            void loadState();
            return false;
          } finally {
            setBusy(false);
          }
        }

        // ---------------------------------------------------------- 动作

        /** 打开一个会话。 */
        function openSessionById(id) {
          const service = serviceOf('uiWorkspace');
          if (service === undefined || typeof service.openSession !== 'function') {
            say('err', t('msg.noUiWorkspace'));
            return;
          }
          try {
            service.openSession(id);
            clearStatus();
          } catch (error) {
            failStatus('msg.openFailed', error);
          }
        }

        /** 打开一个工作区，并让侧栏的工作区面板定位到它。 */
        function openWorkspaceById(id) {
          const service = serviceOf('uiWorkspace');
          if (service === undefined || typeof service.openWorkspace !== 'function') {
            say('err', t('msg.noUiWorkspace'));
            return;
          }
          // 分组行通常已经在侧栏里，先定位一次；打开完成后再补一次，覆盖侧栏重渲染的时机。
          revealWorkspaceInSidebar(id);
          let pending;
          try {
            pending = service.openWorkspace(id);
          } catch (error) {
            failStatus('msg.openFailed', error);
            return;
          }
          Promise.resolve(pending)
            .then(() => revealWorkspaceInSidebar(id))
            .catch((error) => failStatus('msg.openFailed', error));
        }

        /** 在工作区里开新会话。 */
        function startSessionIn(id) {
          const service = serviceOf('uiWorkspace');
          if (service === undefined || typeof service.startSession !== 'function') {
            say('err', t('msg.noUiWorkspace'));
            return;
          }
          try {
            service.startSession(id);
            clearStatus();
          } catch (error) {
            failStatus('msg.openFailed', error);
          }
        }

        /** 原生目录选择器回填对话框。 */
        function pickDirectory() {
          const service = serviceOf('uiWorkspace');
          if (service === undefined || typeof service.pickDirectory !== 'function') {
            say('err', t('msg.noUiWorkspace'));
            return;
          }
          Promise.resolve(service.pickDirectory())
            .then((path) => {
              if (typeof path !== 'string' || path === '') return;
              setDialog((prev) =>
                prev === null || prev.kind !== 'workspace'
                  ? prev
                  : { ...prev, path, title: prev.title === '' ? basenameOf(path) : prev.title },
              );
            })
            .catch((error) => failStatus('msg.openFailed', error));
        }

        /**
         * 删除真实工作区（只删登记）。
         * @param {object} workspace - WorkspaceView。
         */
        async function deleteWorkspace(workspace) {
          setBusy(true);
          try {
            const service = serviceOf('workspaces');
            if (service === undefined || typeof service.delete !== 'function') throw new Error(t('msg.noWorkspaceService'));
            await service.delete(workspace.workspaceId);
            say('ok', t('msg.deleted', { title: workspace.title || basenameOf(workspace.path) }));
            setConfirmDeleteWs('');
            setSelection((prev) => {
              const next = cloneSelection(prev);
              next.workspaces.delete(workspace.workspaceId);
              return next;
            });
          } catch (error) {
            failStatus('msg.deleteFailed', error);
          } finally {
            setBusy(false);
          }
        }

        /**
         * 保存工作区改名。
         * @param {object} workspace - WorkspaceView。
         * @param {string} value - 新标题。
         */
        async function saveWorkspaceRename(workspace, value) {
          const title = clampText(value, LIMITS.maxTitleLength);
          if (title === '') return;
          setBusy(true);
          try {
            const service = serviceOf('workspaces');
            if (service === undefined || typeof service.rename !== 'function') throw new Error(t('msg.noWorkspaceService'));
            await service.rename(workspace.workspaceId, title);
            setRenaming(null);
            say('ok', t('msg.renamed'));
          } catch (error) {
            failStatus('msg.renameFailed', error);
          } finally {
            setBusy(false);
          }
        }

        /**
         * 把一个会话从工作区解挂（不动会话日志）。
         * @param {string} workspaceId - 工作区 id。
         * @param {string} sessionId - 会话 id。
         */
        async function detachSessionFrom(workspaceId, sessionId) {
          setBusy(true);
          try {
            const body = await postJson(ROUTES.detach, { workspaceId, sessionIds: [sessionId] });
            const result = Array.isArray(body?.results) ? body.results[0] : undefined;
            say('ok', result?.status === 'detached' ? t('msg.detached') : t('msg.detachedAbsent'));
          } catch (error) {
            failStatus('msg.detachFailed', error);
          } finally {
            setBusy(false);
          }
        }

        /**
         * 把会话收编进工作区。
         * @param {object} workspace - WorkspaceView。
         * @param {string[]} sessionIds - 会话 id。
         */
        async function adoptSessions(workspace, sessionIds) {
          if (sessionIds.length === 0) {
            say('warn', t('msg.noAdopt'));
            return;
          }
          setBusy(true);
          setDetails([]);
          try {
            const body = await postJson(ROUTES.attach, { workspaceId: workspace.workspaceId, sessionIds });
            const results = Array.isArray(body?.results) ? body.results : [];
            const ok = results.filter((item) => item.status === 'attached' || item.status === 'already');
            const skipped = results.filter((item) => item.status !== 'attached' && item.status !== 'already');
            const parts = [t('msg.adopted', { n: ok.length })];
            if (skipped.length > 0) parts.push(t('msg.skipped', { n: skipped.length }));
            say(skipped.length === 0 ? 'ok' : 'warn', parts.join(' · '));
            setDetails(skipped.map((item) => `${summaryTitle(byId[item.sessionId]) || item.sessionId} — ${t(`reason.${item.status}`)}`));
          } catch (error) {
            failStatus('msg.attachFailed', error);
          } finally {
            setBusy(false);
          }
        }

        /**
         * 打开「新建真实工作区」对话框。
         * @param {object} [prefill] - 预填。
         */
        function openCreateDialog(prefill) {
          const source = prefill === undefined || prefill === null ? {} : prefill;
          setDialog({
            kind: 'workspace',
            path: typeof source.path === 'string' ? source.path : '',
            title: typeof source.title === 'string' ? source.title : '',
            adopt: source.adopt !== false,
            adoptIds: Array.isArray(source.adoptIds) ? source.adoptIds : Array.from(selection.sessions),
          });
        }

        /**
         * 打开「新建 / 合并分组」对话框。
         * @param {'create'|'merge-groups'|'merge-workspaces'} mode - 模式。
         * @param {string[]} ids - 合并时的源分组 id。
         */
        function openGroupDialog(mode, ids) {
          let memberIds = [];
          let title = t('dialog.newGroup');
          if (mode === 'create') {
            memberIds = Array.from(selection.sessions);
          } else {
            const selected = groups.filter((group) => ids.includes(group.id));
            const seen = new Set();
            for (const group of selected) {
              for (const id of group.sessionIds) {
                if (seen.has(id)) continue;
                seen.add(id);
                memberIds.push(id);
              }
            }
            const labels = selected.map((group) => group.title || t('group.untitled')).slice(0, 2);
            title = `${labels.join(' + ')}${selected.length > 2 ? ` + ${selected.length - 2}` : ''}`;
          }
          setDialog({ kind: 'group', mode, ids, title: clampText(title, LIMITS.maxTitleLength), memberIds });
        }

        /** 选中的工作区合并成新分组。 */
        function mergeSelectedWorkspaces() {
          const ids = Array.from(selection.workspaces);
          if (ids.length === 0) {
            say('err', t('msg.needWorkspaces'));
            return;
          }
          const selected = workspaces.filter((workspace) => ids.includes(workspace.workspaceId));
          const seen = new Set();
          const memberIds = [];
          for (const workspace of selected) {
            for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
              if (seen.has(id)) continue;
              seen.add(id);
              memberIds.push(id);
            }
          }
          const labels = selected.map((workspace) => workspace.title || basenameOf(workspace.path)).slice(0, 2);
          const title = `${labels.join(' + ')}${selected.length > 2 ? ` + ${selected.length - 2}` : ''}`;
          setDialog({ kind: 'group', mode: 'merge-workspaces', ids, title: clampText(title, LIMITS.maxTitleLength), memberIds });
        }

        /** 提交分组对话框。 */
        async function submitGroupDialog() {
          if (dialog === null || dialog.kind !== 'group') return;
          const title = clampText(dialog.title, LIMITS.maxTitleLength);
          let next;
          let message;
          if (dialog.mode === 'merge-groups') {
            const merged = mergeGroupList(groups, dialog.ids, title);
            next = merged.groups;
            message = t('msg.groupMerged', { title: merged.group.title || t('group.untitled') });
          } else {
            const added = addGroup(groups, title, dialog.memberIds);
            next = added.groups;
            message = t('msg.groupCreated', { title: added.group.title || t('group.untitled') });
          }
          setDialog(null);
          const ok = await persistGroups(next, message);
          if (ok) setSelection(emptySelection());
        }

        /**
         * 调一次「建工作区 + 收编」，成功返回 true。对话框和一键建共用。
         * @param {string} path - 目录。
         * @param {string} title - 标题。
         * @param {string[]} adoptIds - 要收编的会话。
         * @returns {Promise<boolean>} 是否成功。
         */
        async function createWorkspaceAt(path, title, adoptIds) {
          setBusy(true);
          setDetails([]);
          try {
            const body = await postJson(ROUTES.create, { path, title, adoptSessionIds: adoptIds });
            const skipped = Array.isArray(body?.skipped) ? body.skipped : [];
            const adopted = Array.isArray(body?.adopted) ? body.adopted : [];
            const parts = [t('msg.workspaceReady', { title: body?.title || basenameOf(path) })];
            if (adopted.length > 0) parts.push(t('msg.adopted', { n: adopted.length }));
            if (skipped.length > 0) parts.push(t('msg.skipped', { n: skipped.length }));
            say(skipped.length === 0 ? 'ok' : 'warn', parts.join(' · '));
            setDetails(
              skipped.map((item) => `${summaryTitle(byId[item.sessionId]) || item.sessionId} — ${t(`reason.${item.status}`)}`),
            );
            return true;
          } catch (error) {
            failStatus('msg.createFailed', error);
            return false;
          } finally {
            setBusy(false);
          }
        }

        /** 提交新建工作区对话框。 */
        async function submitCreateDialog() {
          if (dialog === null || dialog.kind !== 'workspace') return;
          const path = String(dialog.path === undefined || dialog.path === null ? '' : dialog.path).trim();
          if (path === '') {
            say('err', t('msg.pathRequired'));
            return;
          }
          const adoptIds = dialog.adopt === true ? dialog.adoptIds : [];
          const ok = await createWorkspaceAt(path, dialog.title, adoptIds);
          if (!ok) return;
          setDialog(null);
          setSelection(emptySelection());
        }

        /**
         * 一键：选中会话 → 同目录已有工作区就收编，没有就用这个目录建一个并收编；
         * 目录不一致时退回对话框让人选目录。
         */
        async function oneClickWorkspace() {
          const ids = Array.from(selection.sessions);
          const plan = planOneClick(ids, byId, workspaces);
          if (plan.mode === 'none') {
            say('err', t('msg.needSessions'));
            return;
          }
          if (plan.mode === 'dialog') {
            say('warn', t('msg.needCommonDir'));
            openCreateDialog({ adopt: true, adoptIds: ids });
            return;
          }
          const owner = plan.mode === 'adopt' ? workspaces.find((workspace) => workspace.workspaceId === plan.workspaceId) : undefined;
          if (owner !== undefined) {
            await adoptSessions(owner, ids);
            return;
          }
          const ok = await createWorkspaceAt(plan.dir, plan.title, ids);
          if (ok) setSelection(emptySelection());
        }

        /**
         * 一键按钮的文案：能归入已有工作区就写它的名字。
         * @returns {string} 文案。
         */
        function oneClickLabel() {
          const plan = planOneClick(Array.from(selection.sessions), byId, workspaces);
          if (plan.mode === 'adopt') return t('action.adoptInto', { title: plan.title });
          return t('action.oneClickWorkspace');
        }

        /** 删除选中的分组。 */
        async function deleteSelectedGroups() {
          const ids = Array.from(selection.groups);
          if (ids.length === 0) return;
          const next = removeGroups(groups, ids);
          setSelection(emptySelection());
          await persistGroups(next, t('msg.groupsDeleted'));
        }

        /** 自动排布：保留展开态、清掉手动位置，然后重算并保存。 */
        async function applyAutoLayout() {
          setDialog(null);
          const current = layoutRef.current;
          const next = {};
          for (const key of Object.keys(current)) {
            next[key] = current[key].expanded === undefined ? {} : { expanded: current[key].expanded };
          }
          layoutRef.current = next;
          setLayoutNodes(next);
          await saveLayoutNow();
          setViewport(fitViewport(placeNodes(graph.nodes, {}), size));
          say('ok', t('msg.autoLayoutDone'));
        }

        /** 重设布局（清空手动位置，保留展开态）。 */
        function resetLayout() {
          const current = layoutRef.current;
          const next = {};
          for (const key of Object.keys(current)) {
            next[key] = current[key].expanded === undefined ? {} : { expanded: current[key].expanded };
          }
          layoutRef.current = next;
          setLayoutNodes(next);
          saveLayoutSoon();
          say('ok', t('msg.layoutReset'));
        }

        /**
         * 按缩放倍率调整视口（以画布中心为锚点）。
         * @param {number} factor - 倍率。
         */
        function zoomBy(factor) {
          const center = { x: size.w / 2, y: size.h / 2 };
          const current = viewportRef.current;
          const zoom = clampZoom(current.zoom * factor);
          const world = screenToWorld(center, current);
          setViewport({ zoom, x: center.x - world.x * zoom, y: center.y - world.y * zoom });
        }

        // ---------------------------------------------------------- 拖拽 / 平移

        /**
         * 节点按下：准备拖动（移动超过 3px 才算拖，否则松手当点击）。
         * @param {object} node - 图节点。
         * @param {object} event - React 指针事件。
         */
        function onNodePointerDown(node, event) {
          if (event.button !== undefined && event.button !== 0) return;
          const rect = placed[node.key];
          if (rect === undefined) return;
          const bases = new Map();
          for (const key of collectSubtreeKeys(graph.nodes, node.key)) {
            const entry = placed[key];
            if (entry !== undefined) bases.set(key, { x: entry.x, y: entry.y });
          }
          dragRef.current = {
            key: node.key,
            startX: event.clientX,
            startY: event.clientY,
            nodeX: rect.x,
            nodeY: rect.y,
            bases,
            moved: false,
            node,
            additive: event.ctrlKey === true || event.metaKey === true || event.shiftKey === true,
            pointerId: event.pointerId,
          };
          const canvas = canvasRef.current;
          if (canvas !== null && canvas !== undefined && typeof canvas.setPointerCapture === 'function' && event.pointerId !== undefined) {
            try {
              canvas.setPointerCapture(event.pointerId);
            } catch {
              /* 指针捕获失败不影响拖动（只是移出画布会丢事件） */
            }
          }
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }

        /**
         * 画布上按下是否该开始平移：空白 / 网格 / 世界层可以，节点、按钮、输入框、缩放条不行。
         * 不能只认 `target === currentTarget`：只要事件从子元素冒上来就永远拖不动
         * （双击留下的选区、选中态的「−」都会踩到）。
         * @param {unknown} target - 事件目标。
         * @param {unknown} canvas - 画布元素。
         * @returns {boolean} 是否开始平移。
         */
        function isPanOrigin(target, canvas) {
          if (target === canvas) return true;
          if (target === null || target === undefined || typeof target.closest !== 'function') return false;
          return target.closest('.wg2-node, .wg2-zoom, button, input, textarea, select, label, a') === null;
        }

        /**
         * 画布按下：空白处开始平移。
         * @param {object} event - React 指针事件。
         */
        function onCanvasPointerDown(event) {
          if (event.button !== undefined && event.button !== 0) return;
          if (!isPanOrigin(event.target, canvasRef.current)) return;
          // 双击按钮/文字留下的选区会让拖动看起来「没反应」：开始平移前先清掉。
          try {
            const selection = typeof window === 'undefined' || typeof window.getSelection !== 'function' ? null : window.getSelection();
            if (selection !== null && selection !== undefined && selection.rangeCount > 0 && typeof selection.removeAllRanges === 'function') {
              selection.removeAllRanges();
            }
          } catch {
            /* 选区 API 不可用时忽略 */
          }
          panRef.current = { startX: event.clientX, startY: event.clientY, vx: viewportRef.current.x, vy: viewportRef.current.y, moved: false };
          const canvas = canvasRef.current;
          if (canvas !== null && canvas !== undefined && typeof canvas.setPointerCapture === 'function' && event.pointerId !== undefined) {
            try {
              canvas.setPointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
          }
        }

        /**
         * 画布移动：优先拖动节点，其次平移视角。
         * @param {object} event - React 指针事件。
         */
        function onCanvasPointerMove(event) {
          const pan = panRef.current;
          if (pan !== null) {
            const dx = event.clientX - pan.startX;
            const dy = event.clientY - pan.startY;
            if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
            if (pan.moved) setViewport({ ...viewportRef.current, x: pan.vx + dx, y: pan.vy + dy });
            return;
          }
          const drag = dragRef.current;
          if (drag === null) return;
          const dxScreen = event.clientX - drag.startX;
          const dyScreen = event.clientY - drag.startY;
          if (!drag.moved && Math.abs(dxScreen) + Math.abs(dyScreen) > 3) drag.moved = true;
          if (!drag.moved) return;
          const scale = viewportRef.current.zoom;
          const current = layoutRef.current;
          const moveX = dxScreen / scale;
          const moveY = dyScreen / scale;
          const next = { ...current };
          const bases = drag.bases instanceof Map ? drag.bases : new Map([[drag.key, { x: drag.nodeX, y: drag.nodeY }]]);
          // 拖容器时整棵子树一起走，否则会话节点会留在原地被拉出长线。
          for (const [key, base] of bases) {
            next[key] = { ...(current[key] ?? {}), x: base.x + moveX, y: base.y + moveY };
          }
          layoutRef.current = next;
          setLayoutNodes(next);
        }

        /**
         * 画布松手：收尾拖动/平移；未移动的节点按下当点击。
         * @param {object} event - React 指针事件。
         */
        function onCanvasPointerUp(event) {
          const pan = panRef.current;
          if (pan !== null) {
            panRef.current = null;
            if (pan.moved !== true) setSelection(emptySelection());
            return;
          }
          const drag = dragRef.current;
          if (drag === null) return;
          dragRef.current = null;
          if (drag.moved === true) {
            saveLayoutSoon();
            // 拖动时关掉了重叠避让（要跟手）；松手后再算一遍，压到别人身上的整块挪开。
            forceRender((value) => value + 1);
          } else {
            selectNode(drag.node, drag.additive === true);
          }
        }

        // ---------------------------------------------------------- 渲染：节点

        /**
         * 展开/收起按钮。
         * @param {object} node - 容器节点。
         * @returns {object} React 元素。
         */
        function renderChevron(node) {
          const open = layoutNodes[node.key] !== undefined && layoutNodes[node.key].expanded === true;
          return h(
            'button',
            {
              type: 'button',
              className: 'wg2-chev',
              title: open ? t('a11y.collapse') : t('a11y.expand'),
              'aria-expanded': open,
              onPointerDown: (event) => {
                if (typeof event.stopPropagation === 'function') event.stopPropagation();
              },
              onClick: (event) => {
                if (typeof event.stopPropagation === 'function') event.stopPropagation();
                toggleExpanded(node.key);
              },
            },
            open ? '▾' : '▸',
          );
        }

        /**
         * 节点选择框。
         * @param {object} node - 图节点。
         * @returns {object} React 元素。
         */
        function renderNodeCheck(node) {
          if (node.kind === 'unassigned') return null;
          const stop = (event) => {
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
          };
          return h(
            'span',
            { onPointerDown: stop, onClick: stop, onDoubleClick: stop },
            h(Check, {
              checked: nodeSelected(node),
              label: node.kind === 'ws' ? t('a11y.selectWorkspace') : node.kind === 'grp' ? t('a11y.selectGroup') : t('a11y.selectSession'),
              onChange: () => selectNode(node, true),
            }),
          );
        }

        /**
         * 状态文案（待处理 / 运行中 / 未读完成）。
         * @param {string} key - pending / running / done。
         * @returns {string} 文案。
         */
        function stateLabel(key) {
          return key === 'pending' ? t('badge.pending') : key === 'running' ? t('badge.running') : key === 'done' ? t('badge.done') : t('status.idle');
        }

        /**
         * 紧凑状态角标：橙点 = 待处理、蓝圈 = 运行中、绿点 = 未读完成；计数始终显示。
         * @param {{pending?: number, running?: number, done?: number}|null|undefined} states - 状态计数。
         * @returns {object|null} React 元素；没有活动时 null。
         */
        function renderStateBadges(states) {
          const source = states !== null && typeof states === 'object' ? states : {};
          const items = [];
          for (const key of STATE_ORDER) {
            const n = typeof source[key] === 'number' && source[key] > 0 ? Math.floor(source[key]) : 0;
            if (n === 0) continue;
            items.push(
              h(
                'span',
                { key, className: `wg2-state wg2-state-${key}`, title: `${stateLabel(key)} ${n}` },
                key === 'running'
                  ? h('i', { className: 'wg2-spin', 'aria-hidden': 'true' })
                  : h('i', { className: `wg2-dot wg2-dot-${key}`, 'aria-hidden': 'true' }),
                h('b', null, String(n)),
              ),
            );
          }
          return items.length === 0 ? null : h('span', { className: 'wg2-states' }, items);
        }

        /**
         * 状态汇总文案（属性面板用；全空显示「空闲」）。
         * @param {{pending?: number, running?: number, done?: number}|null|undefined} states - 状态计数。
         * @returns {string} 例如「待处理 2 · 运行中 1」。
         */
        function stateSummaryText(states) {
          const source = states !== null && typeof states === 'object' ? states : {};
          const parts = [];
          for (const key of STATE_ORDER) {
            const n = typeof source[key] === 'number' && source[key] > 0 ? Math.floor(source[key]) : 0;
            if (n > 0) parts.push(`${stateLabel(key)} ${n}`);
          }
          return parts.length === 0 ? t('status.idle') : parts.join(' · ');
        }

        /**
         * 一个节点（工作区 / 会话 / 分组 / 未归入）。
         * @param {object} node - 图节点。
         * @returns {object} React 元素。
         */
        function renderNode(node) {
          const rect = placed[node.key];
          if (rect === undefined) return null;
          const selected = nodeSelected(node);
          const classes = ['wg2-node', `wg2-node-${node.kind}`];
          if (selected) classes.push('is-selected');
          if (node.dim) classes.push('is-dim');
          if (node.hiddenInSidebar) classes.push('is-hidden-ws');
          const accentState = nodeAccentState(node);
          if (accentState !== '') classes.push(`is-state-${accentState}`);
          const style = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
          const common = {
            key: node.key,
            className: classes.join(' '),
            style,
            onPointerDown: (event) => onNodePointerDown(node, event),
            onDoubleClick: () => {
              if (node.kind === 'sess') openSessionById(node.id);
              else if (node.kind === 'ws') toggleExpanded(node.key);
              else if (node.kind === 'grp') toggleExpanded(node.key);
            },
          };
          if (node.kind === 'sess') {
            const summary = node.ref;
            const chips = [];
            if (node.state === 'pending') {
              chips.push(
                h(
                  Chip,
                  { key: 'state', tone: 'pending', title: t(PENDING_LABEL_KEYS[node.pendingKind] || 'badge.pending') },
                  h('i', { className: 'wg2-dot wg2-dot-pending', 'aria-hidden': 'true' }),
                  t('badge.pending'),
                ),
              );
            } else if (node.state === 'running') {
              chips.push(
                h(
                  Chip,
                  { key: 'state', tone: 'run' },
                  h('i', { className: 'wg2-spin', 'aria-hidden': 'true' }),
                  t('badge.running'),
                ),
              );
            } else if (node.state === 'done') {
              chips.push(
                h(
                  Chip,
                  { key: 'state', tone: 'done' },
                  h('i', { className: 'wg2-dot wg2-dot-done', 'aria-hidden': 'true' }),
                  t('badge.done'),
                ),
              );
            }
            if (pinnedIds.has(node.id)) chips.push(h(Chip, { key: 'pin' }, t('badge.pinned')));
            if (archivedIds.has(node.id)) chips.push(h(Chip, { key: 'arch' }, t('badge.archived')));
            if (summary?.origin === 'subagent') chips.push(h(Chip, { key: 'sub' }, t('badge.subagent')));
            const absolute = formatAbsoluteTime(node.updatedAt);
            const timeLabel = node.updatedAt > 0 ? timeTextOf(timeParts(node.updatedAt)) : '';
            const tooltip = [node.title, node.path, absolute].filter((part) => typeof part === 'string' && part !== '').join('\n');
            return h(
              'div',
              common,
              h(
                'div',
                { className: 'wg2-sess' },
                h(
                  'div',
                  { className: 'wg2-sess-row' },
                  renderNodeCheck(node),
                  h('span', { className: 'wg2-sess-title', title: tooltip }, node.title),
                  timeLabel === '' ? null : h('span', { className: 'wg2-sess-time', title: absolute === '' ? timeLabel : absolute }, timeLabel),
                ),
                chips.length === 0 ? null : h('div', { className: 'wg2-sess-meta' }, chips),
              ),
            );
          }
          const isGroup = node.kind === 'grp';
          const isHub = node.kind === 'unassigned';
          const recentLabel = node.updatedAt > 0 ? timeTextOf(timeParts(node.updatedAt)) : '';
          return h(
            'div',
            common,
            h(
              'div',
              { className: 'wg2-head' },
              isHub ? null : renderChevron(node),
              h('span', { className: 'wg2-head-title', title: node.title }, node.title),
              isHub ? null : renderNodeCheck(node),
            ),
            h(
              'div',
              { className: 'wg2-body-node' },
              node.path === '' ? null : h('div', { className: 'wg2-path', title: node.path }, node.path),
              h(
                'div',
                { className: 'wg2-stats' },
                renderStateBadges(node.states),
                h('span', null, t('count.sessions', { n: node.counts.sessions })),
                isGroup ? h('span', null, t('badge.group')) : null,
                node.kind === 'ws' && node.hiddenInSidebar
                  ? h(Chip, { key: 'hidden', tone: 'muted', title: t('hint.hiddenWs') }, t('badge.hiddenWs'))
                  : null,
                recentLabel === ''
                  ? null
                  : h('span', { className: 'wg2-recent', title: formatAbsoluteTime(node.updatedAt) }, t('label.recent', { time: recentLabel })),
              ),
            ),
          );
        }

        // ---------------------------------------------------------- 渲染：面板

        /**
         * 面板里的一行键值。
         * @param {string} label - 标签。
         * @param {string} value - 值。
         * @returns {object} React 元素。
         */
        function kv(label, value) {
          return h('div', { className: 'wg2-kv', key: `${label}:${value}` }, h('span', null, label), h('b', null, value));
        }

        /** 概览面板。 */
        function renderOverview() {
          return h(
            'div',
            null,
            h('h2', null, t('panel.overview')),
            kv(t('label.workspaces'), String(graph.stats.workspaces)),
            kv(t('label.sessions'), String(graph.stats.sessions)),
            kv(t('label.unassigned'), String(graph.stats.unassigned)),
            kv(t('label.groups'), String(graph.stats.groups)),
            graph.stats.hiddenWorkspaces === 0 ? null : kv(t('label.hiddenInSidebar'), String(graph.stats.hiddenWorkspaces)),
            kv(t('panel.status'), stateSummaryText(graph.stats.states)),
            h('div', { className: 'wg2-hintline' }, t('status.legend')),
            graph.stats.hiddenWorkspaces === 0 ? null : h('div', { className: 'wg2-hintline' }, t('hint.hiddenWs')),
            h('div', { className: 'wg2-hintline' }, t('graph.noSelection')),
            h(
              'div',
              { className: 'wg2-row', style: { marginTop: 10 } },
              h(Btn, { mini: true, onClick: () => setDialog({ kind: 'auto' }) }, t('graph.autoLayout')),
              h(Btn, { mini: true, onClick: () => setViewport(fitViewport(placed, size)) }, t('graph.fit')),
              h(Btn, { mini: true, onClick: () => openCreateDialog() }, t('action.newWorkspace')),
              h(Btn, { mini: true, onClick: resetLayout }, t('action.resetLayout')),
            ),
            h('div', { className: 'wg2-hintline' }, t('graph.hint')),
          );
        }

        /**
         * 工作区属性面板。
         * @param {object} workspace - WorkspaceView。
         * @returns {object} React 元素。
         */
        function renderWorkspacePanel(workspace) {
          const title = workspace.title || basenameOf(workspace.path);
          const memberIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
          const states = aggregateStates(memberIds, byId, sessionStatuses, archivedIds);
          const adoptable = unassignedRowsCache.filter((summary) => canonicalKey(summary.cwd) === canonicalKey(workspace.path));
          const renamingHere = renaming !== null && renaming.kind === 'ws' && renaming.id === workspace.workspaceId;
          const confirming = confirmDeleteWs === workspace.workspaceId;
          return h(
            'div',
            null,
            h('h2', null, t('panel.workspace')),
            renamingHere
              ? h(
                  'div',
                  { className: 'wg2-field' },
                  h('label', null, t('field.title')),
                  h(
                    'div',
                    { className: 'wg2-row' },
                    h('input', {
                      className: 'wg-input',
                      value: renaming.value,
                      autoFocus: true,
                      onChange: (event) => setRenaming({ ...renaming, value: event.target.value }),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') void saveWorkspaceRename(workspace, renaming.value);
                        if (event.key === 'Escape') setRenaming(null);
                      },
                    }),
                    h(Btn, { variant: 'primary', mini: true, onClick: () => void saveWorkspaceRename(workspace, renaming.value) }, t('row.save')),
                    h(Btn, { mini: true, onClick: () => setRenaming(null) }, t('row.cancel')),
                  ),
                )
              : h('div', { className: 'wg2-kv' }, h('span', null, t('field.title')), h('b', null, title)),
            h('div', { className: 'wg2-kv' }, h('span', null, t('field.path')), h('b', { className: 'wg2-path', title: workspace.path }, workspace.path)),
            tishiHiddenIds.has(workspace.workspaceId)
              ? h('div', { className: 'wg2-kv' }, h('span', null, t('field.sidebarVisibility')), h('b', null, t('value.hiddenInSidebar')))
              : null,
            kv(t('label.sessions'), String(memberIds.length)),
            kv(t('badge.pending'), String(states.pending)),
            kv(t('badge.running'), String(states.running)),
            kv(t('badge.done'), String(states.done)),
            h(
              'div',
              { className: 'wg2-row', style: { marginTop: 10 } },
              h(Btn, { mini: true, onClick: () => openWorkspaceById(workspace.workspaceId) }, t('row.open')),
              h(Btn, { mini: true, onClick: () => startSessionIn(workspace.workspaceId) }, t('row.startSession')),
              h(
                Btn,
                { mini: true, onClick: () => setRenaming({ kind: 'ws', id: workspace.workspaceId, value: title }) },
                t('row.rename'),
              ),
            ),
            h(
              'div',
              { className: 'wg2-row', style: { marginTop: 6 } },
              h(
                Btn,
                {
                  mini: true,
                  disabled: adoptable.length === 0,
                  title: adoptable.length === 0 ? t('msg.noAdopt') : adoptable.map((summary) => summaryTitle(summary)).join('\n'),
                  onClick: () => void adoptSessions(workspace, adoptable.map((summary) => summary.id)),
                },
                t('action.adoptable', { n: adoptable.length }),
              ),
              h(
                Btn,
                {
                  mini: true,
                  onClick: () => {
                    setSelection((prev) => {
                      const next = emptySelection();
                      for (const sessionId of memberIds) {
                        if (byId[sessionId] !== undefined && visibleSummary(byId[sessionId], options)) next.sessions.add(sessionId);
                      }
                      void prev;
                      return next;
                    });
                  },
                },
                t('action.selectSessions'),
              ),
            ),
            h(
              'div',
              { className: 'wg2-row', style: { marginTop: 10 } },
              confirming
                ? h(
                    'div',
                    null,
                    h('div', { className: 'wg2-hintline' }, t('confirm.deleteWorkspace', { title })),
                    h(
                      'div',
                      { className: 'wg2-row' },
                      h(Btn, { mini: true, variant: 'danger', onClick: () => void deleteWorkspace(workspace) }, t('row.confirmDelete')),
                      h(Btn, { mini: true, onClick: () => setConfirmDeleteWs('') }, t('row.cancel')),
                    ),
                  )
                : h(Btn, { mini: true, variant: 'danger', onClick: () => setConfirmDeleteWs(workspace.workspaceId) }, t('row.delete')),
            ),
          );
        }

        /**
         * 会话属性面板。
         * @param {object} summary - SessionSummary。
         * @returns {object} React 元素。
         */
        function renderSessionPanel(summary) {
          const owner = workspaceOf(summary, workspaces);
          const parent = typeof summary.parentId === 'string' ? byId[summary.parentId] : undefined;
          const status = statusOf(sessionStatuses, summary.id);
          const state = sessionState(status, summary);
          const stateText =
            state === 'pending'
              ? t(PENDING_LABEL_KEYS[pendingKindOf(status)] || 'badge.pending')
              : state === 'running'
                ? t('badge.running')
                : state === 'done'
                  ? t('badge.done')
                  : t('status.idle');
          return h(
            'div',
            null,
            h('h2', null, t('panel.session')),
            h('div', { className: 'wg2-kv' }, h('span', null, t('field.title')), h('b', null, summaryTitle(summary) || summary.id)),
            summary.cwd === undefined ? null : h('div', { className: 'wg2-kv' }, h('span', null, t('field.path')), h('b', { className: 'wg2-path', title: summary.cwd }, summary.cwd)),
            h('div', { className: 'wg2-kv' }, h('span', null, t('panel.inWorkspace')), h('b', null, owner === null ? t('panel.none') : owner.title || basenameOf(owner.path))),
            parent === undefined
              ? null
              : h('div', { className: 'wg2-kv' }, h('span', null, t('panel.forkParent')), h('b', null, summaryTitle(parent) || parent.id)),
            kv(t('panel.status'), stateText),
            h(
              'div',
              { className: 'wg2-row', style: { marginTop: 10 } },
              h(Btn, { mini: true, onClick: () => openSessionById(summary.id) }, t('row.open')),
              owner === null
                ? null
                : h(
                    Btn,
                    { mini: true, onClick: () => void detachSessionFrom(owner.workspaceId, summary.id) },
                    t('row.detach'),
                  ),
              h(
                Btn,
                {
                  mini: true,
                  disabled: selection.sessions.size === 0,
                  onClick: () => openGroupDialog('create', []),
                },
                t('action.newGroup'),
              ),
              h(
                Btn,
                {
                  mini: true,
                  disabled: selection.sessions.size === 0,
                  title: oneClickLabel(),
                  onClick: () => void oneClickWorkspace(),
                },
                oneClickLabel(),
              ),
            ),
          );
        }

        /**
         * 分组属性面板。
         * @param {object} group - 分组。
         * @returns {object} React 元素。
         */
        function renderGroupPanel(group) {
          const members = group.sessionIds.filter((sessionId) => byId[sessionId] !== undefined);
          const directory = commonDirectory(members, byId);
          const states = aggregateStates(group.sessionIds, byId, sessionStatuses, archivedIds);
          const renamingHere = renaming !== null && renaming.kind === 'grp' && renaming.id === group.id;
          const confirming = confirmDeleteGrp === group.id;
          const title = group.title || t('group.untitled');
          return h(
            'div',
            null,
            h('h2', null, t('panel.group')),
            renamingHere
              ? h(
                  'div',
                  { className: 'wg2-field' },
                  h('label', null, t('field.title')),
                  h(
                    'div',
                    { className: 'wg2-row' },
                    h('input', {
                      className: 'wg-input',
                      value: renaming.value,
                      autoFocus: true,
                      onChange: (event) => setRenaming({ ...renaming, value: event.target.value }),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          void persistGroups(renameGroup(groups, group.id, renaming.value), t('msg.renamed')).then(() => setRenaming(null));
                        }
                        if (event.key === 'Escape') setRenaming(null);
                      },
                    }),
                    h(
                      Btn,
                      {
                        variant: 'primary',
                        mini: true,
                        onClick: () => {
                          void persistGroups(renameGroup(groups, group.id, renaming.value), t('msg.renamed')).then(() => setRenaming(null));
                        },
                      },
                      t('row.save'),
                    ),
                    h(Btn, { mini: true, onClick: () => setRenaming(null) }, t('row.cancel')),
                  ),
                )
              : h('div', { className: 'wg2-kv' }, h('span', null, t('field.title')), h('b', null, title)),
            kv(t('label.members'), String(members.length)),
            kv(t('badge.pending'), String(states.pending)),
            kv(t('badge.running'), String(states.running)),
            kv(t('badge.done'), String(states.done)),
            directory === '' ? null : h('div', { className: 'wg2-kv' }, h('span', null, t('field.path')), h('b', { className: 'wg2-path', title: directory }, directory)),
            h(
              'div',
              { className: 'wg2-row', style: { marginTop: 10 } },
              h(
                Btn,
                {
                  mini: true,
                  disabled: directory === '',
                  title: directory === '' ? t('footer.limit') : directory,
                  onClick: () => openCreateDialog({ path: directory, title: group.title, adopt: true, adoptIds: members }),
                },
                t('row.realize'),
              ),
              h(Btn, { mini: true, onClick: () => setRenaming({ kind: 'grp', id: group.id, value: title }) }, t('row.rename')),
              h(
                Btn,
                {
                  mini: true,
                  onClick: () => {
                    setSelection((prev) => {
                      const next = cloneSelection(prev);
                      next.groups = new Set([group.id]);
                      return next;
                    });
                  },
                },
                t('action.mergeGroups'),
              ),
            ),
            h(
              'div',
              { className: 'wg2-row', style: { marginTop: 10 } },
              confirming
                ? h(
                    'div',
                    null,
                    h('div', { className: 'wg2-hintline' }, t('confirm.deleteGroup', { title })),
                    h(
                      'div',
                      { className: 'wg2-row' },
                      h(
                        Btn,
                        {
                          mini: true,
                          variant: 'danger',
                          onClick: () => {
                            const next = removeGroups(groups, [group.id]);
                            setConfirmDeleteGrp('');
                            setSelection(emptySelection());
                            void persistGroups(next, t('msg.groupsDeleted'));
                          },
                        },
                        t('row.confirmDelete'),
                      ),
                      h(Btn, { mini: true, onClick: () => setConfirmDeleteGrp('') }, t('row.cancel')),
                    ),
                  )
                : h(Btn, { mini: true, variant: 'danger', onClick: () => setConfirmDeleteGrp(group.id) }, t('row.delete')),
            ),
          );
        }

        /**
         * 多选面板。
         * @param {object[]} selectedWorkspaces - 选中的工作区。
         * @param {object[]} selectedSessions - 选中的会话。
         * @param {object[]} selectedGroups - 选中的分组。
         * @returns {object} React 元素。
         */
        function renderMultiPanel(selectedWorkspaces, selectedSessions, selectedGroups) {
          const only =
            selectedSessions.length === selectionTotal
              ? 'sessions'
              : selectedWorkspaces.length === selectionTotal
                ? 'workspaces'
                : selectedGroups.length === selectionTotal
                  ? 'groups'
                  : 'mixed';
          return h(
            'div',
            null,
            h('h2', null, t('panel.multi')),
            h('div', { className: 'wg2-hintline' }, t('graph.selectedCount', { n: selectionTotal })),
            only === 'sessions'
              ? h(
                  'div',
                  { className: 'wg2-row', style: { marginTop: 10 } },
                  h(
                    Btn,
                    { variant: 'primary', mini: true, title: oneClickLabel(), onClick: () => void oneClickWorkspace() },
                    oneClickLabel(),
                  ),
                  h(Btn, { mini: true, onClick: () => openGroupDialog('create', []) }, t('action.newGroup')),
                  h(Btn, { mini: true, onClick: () => openCreateDialog({ adopt: true }) }, t('action.newWorkspace')),
                )
              : null,
            only === 'workspaces'
              ? h(
                  'div',
                  { className: 'wg2-row', style: { marginTop: 10 } },
                  h(Btn, { variant: 'primary', mini: true, onClick: mergeSelectedWorkspaces }, t('action.mergeWorkspaces')),
                )
              : null,
            only === 'groups'
              ? h(
                  'div',
                  { className: 'wg2-row', style: { marginTop: 10 } },
                  h(
                    Btn,
                    {
                      variant: 'primary',
                      mini: true,
                      disabled: selectedGroups.length < 2,
                      onClick: () => {
                        if (selectedGroups.length < 2) {
                          say('err', t('msg.needTwoGroups'));
                          return;
                        }
                        openGroupDialog('merge-groups', Array.from(selection.groups));
                      },
                    },
                    t('action.mergeGroups'),
                  ),
                  h(Btn, { mini: true, variant: 'danger', onClick: () => void deleteSelectedGroups() }, t('action.deleteGroups')),
                )
              : null,
            only === 'mixed' ? h('div', { className: 'wg2-hintline' }, t('sel.hint')) : null,
            h('div', { className: 'wg2-row', style: { marginTop: 10 } }, h(Btn, { mini: true, onClick: () => setSelection(emptySelection()) }, t('action.clear'))),
          );
        }

        /** 右侧属性面板。 */
        function renderPanel() {
          const selectedWorkspaces = Array.from(selection.workspaces)
            .map((id) => workspaceById(id))
            .filter((workspace) => workspace !== undefined);
          const selectedSessions = Array.from(selection.sessions)
            .map((id) => byId[id])
            .filter((summary) => summary !== undefined);
          const selectedGroups = Array.from(selection.groups)
            .map((id) => groupById(id))
            .filter((group) => group !== undefined);
          const total = selectedWorkspaces.length + selectedSessions.length + selectedGroups.length;
          let body;
          if (total === 0) body = renderOverview();
          else if (total === 1 && selectedWorkspaces.length === 1) body = renderWorkspacePanel(selectedWorkspaces[0]);
          else if (total === 1 && selectedSessions.length === 1) body = renderSessionPanel(selectedSessions[0]);
          else if (total === 1 && selectedGroups.length === 1) body = renderGroupPanel(selectedGroups[0]);
          else body = renderMultiPanel(selectedWorkspaces, selectedSessions, selectedGroups);
          return h('aside', { className: 'wg2-panel' }, body);
        }

        // ---------------------------------------------------------- 渲染：对话框

        /** 对话框层。 */
        function renderDialog() {
          if (dialog === null) return null;
          if (dialog.kind === 'auto') {
            return h(
              Dialog,
              {
                key: 'dialog-auto',
                title: t('graph.autoLayout'),
                busy,
                submitText: t('graph.autoLayout'),
                cancelText: t('row.cancel'),
                onClose: () => setDialog(null),
                onSubmit: () => void applyAutoLayout(),
              },
              h('div', { className: 'wg2-hintline' }, t('graph.autoLayoutConfirm')),
            );
          }
          if (dialog.kind === 'group') {
            const merging = dialog.mode !== 'create';
            return h(
              Dialog,
              {
                key: 'dialog-group',
                title: merging ? t('dialog.mergeGroups') : t('dialog.newGroup'),
                subtitle: t('field.members', { n: dialog.memberIds.length }),
                busy,
                submitText: merging ? t('btn.merge') : t('btn.create'),
                cancelText: t('row.cancel'),
                onClose: () => setDialog(null),
                onSubmit: () => void submitGroupDialog(),
              },
              h(
                'div',
                { className: 'wg2-field' },
                h('label', { htmlFor: 'wg2-group-title' }, t('field.title')),
                h('input', {
                  id: 'wg2-group-title',
                  className: 'wg-input',
                  autoFocus: true,
                  value: dialog.title,
                  onChange: (event) => setDialog({ ...dialog, title: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') void submitGroupDialog();
                  },
                }),
              ),
            );
          }
          const preview = dialog.adopt === true ? partitionAdoptable(dialog.adoptIds, byId, dialog.path) : { accepted: [], rejected: [] };
          return h(
            Dialog,
            {
              key: 'dialog-workspace',
              title: t('dialog.newWorkspace'),
              subtitle: t('field.hintPath'),
              busy,
              submitText: t('btn.create'),
              cancelText: t('row.cancel'),
              onClose: () => setDialog(null),
              onSubmit: () => void submitCreateDialog(),
            },
            h(
              'div',
              { className: 'wg2-field' },
              h('label', { htmlFor: 'wg2-path' }, t('field.path')),
              h(
                'div',
                { className: 'wg2-field-row' },
                h('input', {
                  id: 'wg2-path',
                  className: 'wg-input',
                  autoFocus: true,
                  value: dialog.path,
                  placeholder: '/path/to/your/project',
                  onChange: (event) => setDialog({ ...dialog, path: event.target.value }),
                }),
                h(Btn, { onClick: pickDirectory }, t('field.pickDirectory')),
              ),
            ),
            h(
              'div',
              { className: 'wg2-field' },
              h('label', { htmlFor: 'wg2-title' }, t('field.title')),
              h('input', {
                id: 'wg2-title',
                className: 'wg-input',
                value: dialog.title,
                onChange: (event) => setDialog({ ...dialog, title: event.target.value }),
              }),
            ),
            h(
              'label',
              { className: 'wg-toggle', style: { marginTop: 12 } },
              h('input', {
                type: 'checkbox',
                checked: dialog.adopt === true,
                onChange: (event) => setDialog({ ...dialog, adopt: event.target.checked }),
              }),
              h('span', null, t('field.adopt')),
            ),
            dialog.adopt === true
              ? h(
                  'div',
                  null,
                  h('div', { className: 'wg2-hintline' }, t('field.preview', { ok: preview.accepted.length, no: preview.rejected.length })),
                  preview.rejected.length === 0
                    ? null
                    : h(
                        'ul',
                        { className: 'wg-list' },
                        preview.rejected.slice(0, 20).map((item) =>
                          h(
                            'li',
                            { key: item.id },
                            h('span', { className: 'wg-title', title: item.id }, summaryTitle(byId[item.id]) || item.id),
                            h('span', { className: 'wg-meta' }, t(`reason.${item.reason}`)),
                          ),
                        ),
                      ),
                )
              : null,
          );
        }

        // ---------------------------------------------------------------- 渲染

        const selectedCount = selectionTotal;
        const worldOffset = { x: 20 - bounds.minX, y: 20 - bounds.minY };
        const stateTotals = graph.stats.states === undefined || graph.stats.states === null ? { pending: 0, running: 0, done: 0 } : graph.stats.states;
        const stateTotalCount = stateTotals.pending + stateTotals.running + stateTotals.done;

        // 首次量到画布尺寸后：有本机视口且视野里确实有节点就沿用；否则自动适应内容
        // （防止上次退出时的视口漂在空白区，一进来像白页）。
        React.useEffect(() => {
          if (fittedRef.current === true) return;
          if (size.w <= 0 || size.h <= 0 || graph.nodes.length === 0) return;
          fittedRef.current = true;
          if (savedViewport.current !== null && anyNodeVisible(placed, savedViewport.current, size)) return;
          setViewport(fitViewport(placed, size));
        }, [size.w, size.h, graph.nodes.length]);

        // 展开/收起后：被点的容器在屏幕上原地不动（缩放也不变），
        // 展开时再把新出现的子树最小平移进视野——「视图跟随工作区位置」。
        useSyncEffect(() => {
          if (followRequest === null) return;
          const rect = placedRef.current[followRequest.key];
          setFollowRequest(null);
          if (rect === undefined || size.w <= 0 || size.h <= 0) return;
          const subtree = [];
          if (followRequest.expanding === true) {
            for (const key of collectSubtreeKeys(graph.nodes, followRequest.key)) {
              const item = placedRef.current[key];
              if (item !== undefined) subtree.push(item);
            }
          }
          setViewport(
            followViewport(
              followRequest.anchor,
              rect,
              subtree.length > 0 ? subtree : [rect],
              size,
              followRequest.zoom,
            ),
          );
        }, [followRequest]);

        // 筛选条件（只看进行中与未读完成 / 搜索）变化后：自动缩放并居中到筛选结果，
        // 让结果直接出现在视野中央；首次挂载沿用本机视口，空结果保持原视口不动。
        React.useEffect(() => {
          const last = filterFitRef.current;
          if (last.focusActive !== focusActive || last.query !== query) {
            filterFitRef.current = { focusActive, query };
            pendingFilterFitRef.current = true;
          }
          if (!pendingFilterFitRef.current) return;
          if (size.w <= 0 || size.h <= 0 || graph.nodes.length === 0) return;
          pendingFilterFitRef.current = false;
          setViewport(fitViewport(placed, size));
        }, [focusActive, query, size.w, size.h, graph.nodes.length]);

        return h(
          'div',
          { className: 'wg2-root' },
          h('style', { key: 'css' }, `${CSS}\n${NODE_CSS}`),
          h(
            'div',
            { className: 'wg2-top', key: 'top' },
            h('span', { className: 'wg2-title' }, t('panel.title')),
            h('input', {
              className: 'wg-input wg2-search',
              value: query,
              placeholder: t('toolbar.searchPlaceholder'),
              'aria-label': t('toolbar.searchPlaceholder'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'label',
              { className: 'wg-toggle' },
              h('input', { type: 'checkbox', checked: focusActive, 'aria-label': t('toolbar.focusActive'), onChange: (event) => setFocusActive(event.target.checked) }),
              h('span', null, t('toolbar.focusActive')),
            ),
            h(
              'label',
              { className: 'wg-toggle' },
              h('input', { type: 'checkbox', checked: showArchived, onChange: (event) => setShowArchived(event.target.checked) }),
              h('span', null, t('toolbar.showArchived')),
            ),
            h(
              'label',
              { className: 'wg-toggle' },
              h('input', { type: 'checkbox', checked: showSubagent, onChange: (event) => setShowSubagent(event.target.checked) }),
              h('span', null, t('toolbar.showSubagent')),
            ),
            h(
              'label',
              { className: 'wg-toggle' },
              h('input', { type: 'checkbox', checked: showGroups, onChange: (event) => setShowGroups(event.target.checked) }),
              h('span', null, t('graph.showGroups')),
            ),
            hiddenWorkspaceCount === 0 && !showHidden
              ? null
              : h(
                  'label',
                  { className: 'wg-toggle' },
                  h('input', { type: 'checkbox', checked: showHidden, 'aria-label': t('toolbar.showHidden', { n: hiddenWorkspaceCount }), onChange: (event) => setShowHidden(event.target.checked) }),
                  h('span', null, t('toolbar.showHidden', { n: hiddenWorkspaceCount })),
                ),
            h('span', { className: 'wg-meta' }, t('graph.stat', { w: graph.nodes.length, e: edgePaths.length })),
            stateTotalCount === 0
              ? null
              : h(
                  'span',
                  {
                    className: 'wg2-totals',
                    title: t('status.summary', { p: stateTotals.pending, r: stateTotals.running, d: stateTotals.done }),
                  },
                  renderStateBadges(stateTotals),
                ),
            h(Btn, { mini: true, onClick: expandAll }, t('graph.expandAll')),
            h(Btn, { mini: true, onClick: collapseAll }, t('graph.collapseAll')),
            h(Btn, { mini: true, onClick: () => setDialog({ kind: 'auto' }) }, t('graph.autoLayout')),
            h(Btn, { mini: true, onClick: () => setViewport(fitViewport(placed, size)) }, t('graph.fit')),
            h(Btn, { mini: true, onClick: () => openCreateDialog() }, t('action.newWorkspace')),
          ),
          h(
            'div',
            { className: 'wg2-body', key: 'body' },
            h(
              'div',
              {
                className: panRef.current === null ? 'wg2-canvas' : 'wg2-canvas is-panning',
                ref: canvasRef,
                key: 'canvas',
                onPointerDown: onCanvasPointerDown,
                onPointerMove: onCanvasPointerMove,
                onPointerUp: onCanvasPointerUp,
                onPointerCancel: onCanvasPointerUp,
              },
              degraded
                ? h('div', { className: 'wg2-hintline', style: { padding: 20 } }, t('msg.degraded'))
                : h(
                    'div',
                    {
                      className: 'wg2-world',
                      style: {
                        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                      },
                    },
                    h(
                      'svg',
                      {
                        className: 'wg2-edges',
                        style: { left: bounds.minX - 20, top: bounds.minY - 20, width: bounds.width + 40, height: bounds.height + 40 },
                        'aria-hidden': 'true',
                      },
                      h(
                        'defs',
                        null,
                        ['strong', 'soft', 'brand'].map((tone) =>
                          h(
                            'marker',
                            {
                              key: tone,
                              id: `wg2-arrow-${tone}`,
                              markerWidth: 8,
                              markerHeight: 8,
                              refX: 7,
                              refY: 4,
                              orient: 'auto',
                            },
                            h('path', {
                              d: 'M0,0 L8,4 L0,8 z',
                              style: {
                                fill:
                                  tone === 'strong'
                                    ? 'var(--dsw-alias-label-secondary)'
                                    : tone === 'brand'
                                      ? 'var(--dsw-alias-brand-primary)'
                                      : 'var(--dsw-alias-border-l2)',
                              },
                            }),
                          ),
                        ),
                      ),
                      h(
                        'g',
                        { transform: `translate(${worldOffset.x}, ${worldOffset.y})` },
                        edgePaths.map((edge) => {
                          const marker =
                            edge.kind === 'nest' ? 'url(#wg2-arrow-strong)' : edge.kind === 'member' ? 'url(#wg2-arrow-soft)' : edge.kind === 'fork' ? 'url(#wg2-arrow-brand)' : undefined;
                          return h('path', {
                            key: edge.key,
                            className: `wg2-edge wg2-edge-${edge.kind}`,
                            d: edge.d,
                            markerEnd: marker,
                          });
                        }),
                      ),
                    ),
                    graph.nodes.map((node) => renderNode(node)),
                  ),
              focusActive && !degraded && graph.nodes.length === 0
                ? h('div', { className: 'wg2-hintline wg2-focus-empty', key: 'focus-empty' }, t('empty.focus'))
                : null,
              h(
                'div',
                { className: 'wg2-zoom', key: 'zoom', onMouseDown: (event) => {
                  // 别让双击缩放按钮选中「−」的字：选区一出现，画布看起来就拖不动了。
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                } },
                h(Btn, { mini: true, title: t('graph.zoomOut'), onClick: () => zoomBy(1 / 1.25) }, '−'),
                h(Btn, { mini: true, title: t('graph.zoomIn'), onClick: () => zoomBy(1.25) }, '+'),
                h(Btn, { mini: true, title: t('graph.fit'), onClick: () => setViewport(fitViewport(placed, size)) }, '⤢'),
                h(Btn, { mini: true, title: t('graph.reset'), onClick: () => setViewport({ x: 60, y: 60, zoom: 1 }) }, '⟲'),
              ),
            ),
            renderPanel(),
          ),
          status.text === '' ? null : h('div', { className: `wg2-status wg2-status-${status.kind}`, key: 'status', role: 'status', 'aria-live': 'polite' }, status.text),
          details.length === 0
            ? null
            : h(
                'div',
                { key: 'details', style: { padding: '0 16px 8px' } },
                h('div', { className: 'wg2-hintline' }, t('detail.title')),
                h('ul', { className: 'wg-detail' }, details.map((text, index) => h('li', { key: `d${index}` }, text))),
              ),
          groupsPhase === 'loading' ? h('div', { className: 'wg2-hintline', key: 'loading', style: { padding: '0 16px' } }, t('msg.loading')) : null,
          selectedCount > 0 ? h('div', { className: 'wg2-hintline', key: 'sel', style: { padding: '0 16px' } }, t('graph.selectedCount', { n: selectedCount })) : null,
          renderDialog(),
        );
      };
    }

    // ---------------------------------------------------------------- 节点样式

    const NODE_CSS = [
      '.wg2-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);overflow:hidden}',
      '.wg2-top{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:calc(var(--dsh-frame-top-clearance,48px) + 12px) 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.wg2-title{font-size:15px;font-weight:650;margin-right:6px}',
      '.wg2-search{flex:0 1 240px;min-width:140px;width:auto}',
      '.wg2-body{flex:1 1 auto;display:flex;min-height:0;min-width:0}',
      '.wg2-canvas{position:relative;flex:1 1 auto;overflow:hidden;cursor:grab;background-color:var(--dsw-alias-bg-base);background-image:radial-gradient(circle, var(--dsw-alias-border-l1) 1px, transparent 1px);background-size:24px 24px;touch-action:none;user-select:none;-webkit-user-select:none}',
      '.wg2-canvas.is-panning{cursor:grabbing}',
      '.wg2-world{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;will-change:transform}',
      '.wg2-edges{position:absolute;pointer-events:none;overflow:visible}',
      '.wg2-edge{fill:none;stroke-linecap:round;stroke-linejoin:round}',
      '.wg2-edge-nest{stroke:var(--dsw-alias-label-secondary);stroke-width:1.6}',
      '.wg2-edge-member{stroke:var(--dsw-alias-border-l2);stroke-width:1.1}',
      '.wg2-edge-fork{stroke:var(--dsw-alias-brand-primary);stroke-width:1.4;stroke-dasharray:6 4}',
      '.wg2-edge-group{stroke:var(--dsw-alias-brand-primary);stroke-width:1.2;stroke-dasharray:2 4}',
      '.wg2-edge-unassigned{stroke:var(--dsw-alias-border-l2);stroke-width:1.1;stroke-dasharray:2 4}',
      '.wg2-node{position:absolute;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden;cursor:grab;user-select:none}',
      '.wg2-node:active{cursor:grabbing}',
      '.wg2-node.is-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}',
      '.wg2-node.is-dim{opacity:.38}',
      '.wg2-node.is-hidden-ws{opacity:.62;border-style:dashed}',
      '.wg2-node.is-state-pending{--state-accent:var(--dsw-alias-state-warn-primary);background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent),transparent 62%),var(--dsw-alias-bg-layer-1)}',
      '.wg2-node.is-state-running{--state-accent:var(--dsw-alias-state-business-primary)}',
      '.wg2-node.is-state-done{--state-accent:var(--dsw-alias-state-success-primary)}',
      '.wg2-node-sess.is-state-pending::before,.wg2-node-sess.is-state-running::before,.wg2-node-sess.is-state-done::before,.wg2-node-grp.is-state-pending::before,.wg2-node-grp.is-state-running::before,.wg2-node-grp.is-state-done::before,.wg2-node-unassigned.is-state-pending::before,.wg2-node-unassigned.is-state-running::before,.wg2-node-unassigned.is-state-done::before{content:"";position:absolute;top:0;bottom:0;left:0;width:3px;background:var(--state-accent);z-index:2;pointer-events:none}',
      '.wg2-node-ws{border-left:3px solid var(--state-accent,var(--dsw-alias-brand-primary))}',
      '.wg2-node-grp{border-style:dashed}',
      '.wg2-node-unassigned{border-style:dashed;border-color:var(--dsw-alias-label-secondary)}',
      '.wg2-head{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;min-width:0}',
      '.wg2-head-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:650}',
      '.wg2-body-node{padding:6px 8px;display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}',
      '.wg2-path{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.wg2-stats{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap}',
      // 状态角标：橙点 = 待处理、蓝旋转圈 = 运行中、绿点 = 未读完成；数字始终显示。
      '.wg2-states{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;flex:0 0 auto}',
      '.wg2-state{--state-color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:4px;padding:0 6px;border:1px solid color-mix(in srgb,var(--state-color) 45%,transparent);border-radius:999px;background:color-mix(in srgb,var(--state-color) 16%,transparent);color:color-mix(in srgb,var(--state-color) 72%,var(--dsw-alias-label-primary));font-size:10.5px;font-weight:700;line-height:1.4;font-variant-numeric:tabular-nums}',
      '.wg2-state b{font-weight:800;color:inherit}',
      '.wg2-state-pending{--state-color:var(--dsw-alias-state-warn-primary)}',
      '.wg2-state-running{--state-color:var(--dsw-alias-state-business-primary)}',
      '.wg2-state-done{--state-color:var(--dsw-alias-state-success-primary)}',
      '.wg2-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 2px color-mix(in srgb,var(--state-color,var(--dsw-alias-label-secondary)) 20%,transparent)}',
      '.wg2-dot-pending{background:var(--dsw-alias-state-warn-primary);--state-color:var(--dsw-alias-state-warn-primary)}',
      '.wg2-dot-done{background:var(--dsw-alias-state-success-primary);--state-color:var(--dsw-alias-state-success-primary)}',
      '.wg2-spin{display:inline-block;width:9px;height:9px;border-radius:50%;box-sizing:border-box;border:2px solid currentColor;border-top-color:transparent;flex:0 0 auto;animation:wg2-spin .9s linear infinite}',
      '@keyframes wg2-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.wg2-spin{animation:none}}',
      '.wg2-totals{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.wg2-sess-meta .wg-chip{display:inline-flex;align-items:center;gap:4px}',
      '.wg2-sess{flex:1 1 auto;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:0 8px;min-width:0}',
      '.wg2-sess-row{display:flex;align-items:center;gap:6px;min-width:0;width:100%}',
      '.wg2-sess-title{flex:1 1 auto;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wg2-sess-time{flex:0 0 auto;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.wg2-sess-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}',
      '.wg2-recent{white-space:nowrap}',
      '.wg2-chev{flex:0 0 auto;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;width:16px;height:16px;font-size:10px;line-height:1;border-radius:4px}',
      '.wg2-chev:hover{background:var(--dsw-alias-bg-base)}',
      '.wg2-node .wg-check{width:12px;height:12px}',
      '.wg2-zoom{position:absolute;right:12px;bottom:12px;display:flex;gap:4px;z-index:3}',
      '.wg2-panel{flex:0 0 320px;border-left:1px solid var(--dsw-alias-border-l1);padding:12px 14px;overflow-y:auto;background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}',
      '.wg2-panel h2{margin:0 0 8px;font-size:13px;font-weight:650}',
      '.wg2-field{display:flex;flex-direction:column;gap:5px;margin-top:10px}',
      '.wg2-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.wg2-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.wg2-kv{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0;min-width:0}',
      '.wg2-kv b{font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wg2-hintline{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55;margin:6px 0}',
      '.wg2-focus-empty{position:absolute;left:24px;top:24px;z-index:2;margin:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}',
      '.wg2-status{margin:6px 12px;padding:8px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:0 0 auto}',
      '.wg2-status-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.wg2-status-warn{border-color:var(--dsw-alias-border-l2)}',
    ].join('');

    // -------------------------------------------------------------- 接线

    /**
     * 客户端插件主体。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.locale.register(NS, 'zh', DICT.zh);
      ctx.locale.register(NS, 'en', DICT.en);
      const t = makeT(ctx.locale.bind(NS));
      const Panel = makePanel(ctx, t);
      const Boundary = makeBoundary(t);
      if (TEST !== null) TEST.renderPanel = Panel;

      ctx.effect(
        () =>
          ctx.slots.inject(SIDEBAR_SLOT, () =>
            ctx.slots.register(
              {
                name: SIDEBAR_SLOT,
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: () => t('panel.title'),
              },
              Icon,
            ),
          ),
        'workspace-graph: sidebar entry',
      );

      ctx.effect(
        () =>
          ctx.slots.inject(MAIN_SLOT, () =>
            ctx.slots.register(
              {
                name: MAIN_SLOT,
                key: PANEL_ID,
              },
              (props) => h(Boundary, null, h(Panel, props)),
            ),
          ),
        'workspace-graph: main panel',
      );
    }

    // 离线测试钩子（生产环境 __WORKSPACE_GRAPH_TEST__ 不存在，无副作用）
    const TEST =
      typeof globalThis === 'object' &&
      globalThis.__WORKSPACE_GRAPH_TEST__ !== null &&
      typeof globalThis.__WORKSPACE_GRAPH_TEST__ === 'object'
        ? globalThis.__WORKSPACE_GRAPH_TEST__
        : null;
    if (TEST !== null) {
      TEST.PANEL_ID = PANEL_ID;
      TEST.ROUTES = ROUTES;
      TEST.LIMITS = LIMITS;
      TEST.DICT = DICT;
      TEST.NODE_SIZE = NODE_SIZE;
      TEST.canonicalKey = canonicalKey;
      TEST.basenameOf = basenameOf;
      TEST.clampText = clampText;
      TEST.summaryTitle = summaryTitle;
      TEST.timeParts = timeParts;
      TEST.visibleSummary = visibleSummary;
      TEST.nestRows = nestRows;
      TEST.workspaceRows = workspaceRows;
      TEST.unassignedRows = unassignedRows;
      TEST.suggestWorkspace = suggestWorkspace;
      TEST.workspaceOf = workspaceOf;
      TEST.partitionAdoptable = partitionAdoptable;
      TEST.commonDirectory = commonDirectory;
      TEST.planOneClick = planOneClick;
      TEST.compareSessionsForDisplay = compareSessionsForDisplay;
      TEST.latestActivity = latestActivity;
      TEST.formatAbsoluteTime = formatAbsoluteTime;
      TEST.collectSubtreeKeys = collectSubtreeKeys;
      TEST.normalizeGroups = normalizeGroups;
      TEST.addGroup = addGroup;
      TEST.removeGroups = removeGroups;
      TEST.renameGroup = renameGroup;
      TEST.mergeGroupList = mergeGroupList;
      TEST.emptySelection = emptySelection;
      TEST.cloneSelection = cloneSelection;
      TEST.toggleIn = toggleIn;
      TEST.Icon = Icon;
      TEST.containerKey = containerKey;
      TEST.sessionKey = sessionKey;
      TEST.pathParentOf = pathParentOf;
      TEST.buildWorkspaceForest = buildWorkspaceForest;
      TEST.readTishiHiddenWorkspaceIds = readTishiHiddenWorkspaceIds;
      TEST.sessionForkDepth = sessionForkDepth;
      TEST.buildGraph = buildGraph;
      TEST.sessionState = sessionState;
      TEST.pendingKindOf = pendingKindOf;
      TEST.statusOf = statusOf;
      TEST.aggregateStates = aggregateStates;
      TEST.nodeAccentState = nodeAccentState;
      TEST.PENDING_LABEL_KEYS = PENDING_LABEL_KEYS;
      TEST.compareNodes = compareNodes;
      TEST.placeNodes = placeNodes;
      TEST.edgePath = edgePath;
      TEST.buildEdgePaths = buildEdgePaths;
      TEST.worldBounds = worldBounds;
      TEST.clampZoom = clampZoom;
      TEST.screenToWorld = screenToWorld;
      TEST.worldToScreen = worldToScreen;
      TEST.fitViewport = fitViewport;
      TEST.followViewport = followViewport;
      TEST.anyNodeVisible = anyNodeVisible;
      TEST.rectsOverlap = rectsOverlap;
      TEST.nearestFreeShift = nearestFreeShift;
      TEST.separateManualNodes = separateManualNodes;
      TEST.normalizeLayout = normalizeLayout;
      TEST.CSS = `${CSS}\n${NODE_CSS}`;
    }

    return {
      name: PANEL_ID,
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
