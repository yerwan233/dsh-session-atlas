# dsh-session-atlas

A Blender-style node canvas that lives in the DSH sidebar and draws your **real
workspaces and their sessions** as one live graph.

侧栏「工作区图」：把真实工作区和会话画成一张可操作的节点关系图。

## What it does

- **Nodes for real things.** Each node is a real workspace directory or a real
  session — not a copy kept in sync.
- **Edges with meaning.** Directory nesting, session forks and subagent
  sessions get their own edge styles.
- **Live status badges.** Pending, running and unread-done sessions are marked
  on the node and summed up at the top of the page.
- **Focus mode.** Keep only pending / running / unread-done sessions, together
  with the workspaces they belong to; the canvas zooms to fit after focus or
  after search filtering.
- **Groups.** Multi-select sessions to create a group, merge groups, anchor
  members and plan a one-click creation.
- **Native workspace operations.** Create a real workspace, adopt sessions
  that already live in the same directory, rename and delete — through the
  host, so the sidebar stays the source of truth.
- **Optional dsh_tishi mirror.** If `dsh_tishi` is installed, workspaces it has
  hidden are dimmed instead of drawn, with a reveal toggle.

## Requirements

- DSH desktop with the plugin manager.
- Node.js 22+ inside the DSH runtime.
- No runtime dependencies.

## Install

1. Open DSH desktop → **Plugins → Add plugin**.
2. Enter `dsh-session-atlas` (or a Git URL / local path to this package).
3. Quit the app from the tray and relaunch.

After the first launch the page appears in the sidebar. Host changes can be
hot-reloaded by toggling the plugin off and on; **client changes need a page
refresh**.

## Using it

- Drag empty canvas to pan, use the wheel or the toolbar to zoom, and the fit
  action to centre everything again.
- Drag a node to move its subtree; positions stick to the node they were put
  on and survive a reload.
- Use the toolbar to create a workspace, create a group from the current
  selection, or switch the status filter.

## Data and persistence

Groups and layout are stored by the Host as one JSON file:

- default: `%DSH_HOME%\workspace-graph\groups.json`;
- override: environment variable `DSH_WORKSPACE_GRAPH_FILE` (absolute path).

Deleting that file only resets this plugin's grouping and layout; it does not
touch DSH workspaces, sessions or `workspace.json`.

## Known limitations

- Visual polish (light/dark theme, spacing, drag feel) is verified by eye; the
  self-test does not take browser screenshots.
- **Groups are plugin data, not DSH workspaces.** Creating a group does not
  change the native workspace tree in the sidebar.
- Adopting "old sessions with the same directory" is bounded by the host: a
  session can only be attached when the realpath of its `cwd` equals the
  workspace directory. Everything else is reported per session, and "merge
  workspaces" produces a group rather than a real workspace.
- Node interaction is pointer-first; canvas nodes are not tab-focusable, keyboard
  access is limited to buttons and inputs.
- The `dsh_tishi` hidden-workspace mirror only shows up when that plugin is
  installed.

## License

MIT. See [LICENSE](LICENSE).
