import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_LAYOUT_KEYS,
  WORKSPACE_LAYOUT_LIMITS,
  normalizeBrowserWidth,
  normalizeDensity,
  normalizeInspectorWidth,
} from './workspaceLayout';
import {
  isApplicationMenuCommandChecked,
  isApplicationMenuCommandEnabled,
} from './applicationMenuCommands';
import { APPLICATION_MENUS } from './applicationMenu';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8');
const appSource = () => read('src/App.tsx');
const indexCss = () => read('src/index.css');
const menuSource = () => read('src/state/applicationMenu.ts');
const menuCommandsSource = () => read('src/state/applicationMenuCommands.ts');

// Helper to make a minimal deps state source for checked resolvers
const stateSource = (overrides: Partial<{
  isBrowserOpen: () => boolean;
  isInspectorOpen: () => boolean;
  getDensity: () => 'compact' | 'comfy';
  currentView: () => any;
  isFullscreen: () => boolean;
  isMetronomeOn: () => boolean;
  isRecording: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  hasSelectedChannel: () => boolean;
  canDeleteSelectedChannel: () => boolean;
}> = {}) => ({
  canUndo: () => true,
  canRedo: () => true,
  hasSelectedChannel: () => true,
  canDeleteSelectedChannel: () => true,
  currentView: () => 'playlist' as any,
  isBrowserOpen: () => true,
  isInspectorOpen: () => true,
  getDensity: () => 'comfy' as const,
  isFullscreen: () => false,
  isMetronomeOn: () => false,
  isRecording: () => false,
  ...overrides,
});

test('Browser and Inspector limits are correct and collapsed rails are 40', () => {
  assert.equal(WORKSPACE_LAYOUT_LIMITS.browser.collapsed, 40);
  assert.equal(WORKSPACE_LAYOUT_LIMITS.inspector.collapsed, 40);
  assert.equal(WORKSPACE_LAYOUT_LIMITS.browser.min, 140);
  assert.equal(WORKSPACE_LAYOUT_LIMITS.browser.max, 320);
  assert.equal(WORKSPACE_LAYOUT_LIMITS.inspector.min, 240);
  assert.equal(WORKSPACE_LAYOUT_LIMITS.inspector.max, 360);
});

test('App initializes collapsed state from localStorage with safe fallback', () => {
  const app = appSource();
  // browserCollapsed
  assert.ok(app.includes("window.localStorage.getItem('apex:browserCollapsed')"), 'reads browserCollapsed');
  assert.ok(app.includes("window.localStorage.getItem('apex:inspectorCollapsed')"), 'reads inspectorCollapsed');
  // safe fallback via try/catch and window undefined guard
  assert.ok(app.includes('try {') && app.includes('window.localStorage.getItem'), 'safe localStorage read');
  // default based on innerWidth
  assert.ok(app.includes('window.innerWidth >= 1024'), 'browser default uses innerWidth');
});

test('App persists browser/inspector collapsed flags and widths with validation', () => {
  const app = appSource();
  // App persists via WORKSPACE_LAYOUT_KEYS constants (which resolve to apex:...)
  assert.ok(app.includes('WORKSPACE_LAYOUT_KEYS.browserWidth') || app.includes('apex:browserWidth'), 'persists browserWidth');
  assert.ok(app.includes('WORKSPACE_LAYOUT_KEYS.inspectorWidth') || app.includes('apex:inspectorWidth'), 'persists inspectorWidth');
  assert.ok(app.includes('WORKSPACE_LAYOUT_KEYS.density') || app.includes('apex:density'), 'persists density');
  assert.ok(app.includes('apex:browserCollapsed'), 'persists browserCollapsed');
  assert.ok(app.includes('apex:inspectorCollapsed'), 'persists inspectorCollapsed');
  // writes via safe helper or try/catch
  assert.ok(app.includes('writeWorkspaceLayoutPreference') || app.includes('localStorage.setItem'), 'writes via safe preference');
  // browser/inspector widths are normalized via clamp
  assert.ok(app.includes('normalizeBrowserWidth'), 'browser width normalized');
  assert.ok(app.includes('normalizeInspectorWidth'), 'inspector width normalized');
  assert.ok(app.includes('normalizeDensity'), 'density normalized');
});

test('Browser and Inspector collapse to 40 and restore expanded width', () => {
  const app = appSource();
  // collapsed constant used
  assert.ok(app.includes('WORKSPACE_LAYOUT_LIMITS.browser.collapsed'), 'browser collapsed constant');
  assert.ok(app.includes('WORKSPACE_LAYOUT_LIMITS.inspector.collapsed'), 'inspector collapsed constant');
  // browserWidth derived
  assert.ok(app.includes('const browserWidth = isSidebarOpen ? browserExpandedWidth : WORKSPACE_LAYOUT_LIMITS.browser.collapsed'), 'browserWidth derive');
  assert.ok(app.includes('const inspectorWidth = isInspectorOpen ? inspectorExpandedWidth : WORKSPACE_LAYOUT_LIMITS.inspector.collapsed'), 'inspectorWidth derive');
  // rails with expand buttons
  assert.ok(app.includes('aria-label="Expand Studio Browser"'), 'browser expand rail');
  assert.ok(app.includes('aria-label="Expand Inspector"'), 'inspector expand rail');
  assert.ok(app.includes('aria-label="Collapse Inspector"'), 'inspector collapse button');
  // ensure both panes have data-collapsed attribute
  assert.ok(app.includes('data-collapsed={!isSidebarOpen}'), 'browser pane data-collapsed');
  assert.ok(app.includes('data-collapsed={!isInspectorOpen}'), 'inspector pane data-collapsed');
});

test('Width persistence restores expanded width after collapse', () => {
  const app = appSource();
  // expanded widths are separate state from collapsed
  assert.ok(app.includes('browserExpandedWidth'), 'browserExpandedWidth state');
  assert.ok(app.includes('inspectorExpandedWidth'), 'inspectorExpandedWidth state');
  assert.ok(app.includes('setBrowserExpandedWidth'), 'updates expanded width');
  assert.ok(app.includes('setInspectorExpandedWidth'), 'updates inspector expanded width');
  // persisted expanded widths are loaded via load* helpers
  assert.ok(app.includes('loadBrowserWidth()'), 'loads browser width');
  assert.ok(app.includes('loadInspectorWidth()'), 'loads inspector width');
  assert.ok(app.includes('loadDensity()'), 'loads density');
});

test('Keyboard resizing - ArrowLeft/Right, Home/End, Shift step 24', () => {
  const app = appSource();
  assert.ok(app.includes('handleGutterKeyDown'), 'has gutter keydown handler');
  assert.ok(app.includes("ArrowLeft"), 'handles ArrowLeft');
  assert.ok(app.includes("ArrowRight"), 'handles ArrowRight');
  assert.ok(app.includes("Home"), 'handles Home');
  assert.ok(app.includes("End"), 'handles End');
  assert.ok(app.includes('event.shiftKey ? 24 : 8'), 'shift step 24 vs 8');
  // browser and inspector both handled
  assert.ok(app.includes("gutter === 'browser'"), 'handles browser gutter');
  assert.ok(app.includes("gutter === 'inspector'"), 'handles inspector gutter');
  // ensure preventDefault on these keys
  assert.ok(app.includes('event.preventDefault()') && app.includes('ArrowLeft'), 'prevents default');
});

test('Density switching - compact/comfy via View menu and inspector radios', () => {
  const app = appSource();
  // App has density state with loadDensity and normalizeDensity
  assert.ok(app.includes('loadDensity()'), 'loads density');
  assert.ok(app.includes('setDensity'), 'sets density');
  assert.ok(app.includes("normalizeDensity"), 'normalizes density');
  // inspector pane has density radios
  assert.ok(app.includes('role="radio"'), 'density radios have role');
  assert.ok(app.includes('aria-checked={density ==='), 'radios reflect density');
  assert.ok(app.includes("setDensity('compact')"), 'compact radio');
  assert.ok(app.includes("setDensity('comfy')"), 'comfy radio');
  // menu commands exist
  const viewMenu = APPLICATION_MENUS.find(m => m.id === 'view')!;
  const densityCompact = viewMenu.items.find(i => (i as any).id === 'view.densityCompact');
  const densityComfy = viewMenu.items.find(i => (i as any).id === 'view.densityComfy');
  assert.ok(densityCompact, 'view.densityCompact in menu');
  assert.ok(densityComfy, 'view.densityComfy in menu');
  // index.css uses #apex-workspace-main[data-density]
  assert.ok(indexCss().includes('#apex-workspace-main[data-density="compact"]'), 'css compact');
  assert.ok(indexCss().includes('#apex-workspace-main[data-density="comfy"]'), 'css comfy');
  assert.ok(indexCss().includes('--apex-lane-height: 64px'), 'comfy 64');
  assert.ok(indexCss().includes('--apex-lane-height: 48px'), 'compact 48');
});

test('View menu command state - browser, inspector, density checked resolvers', () => {
  // browser checked reflects isBrowserOpen
  assert.equal(isApplicationMenuCommandChecked('view.browser', stateSource({ isBrowserOpen: () => true })), true);
  assert.equal(isApplicationMenuCommandChecked('view.browser', stateSource({ isBrowserOpen: () => false })), false);
  assert.equal(isApplicationMenuCommandChecked('view.inspector', stateSource({ isInspectorOpen: () => true })), true);
  assert.equal(isApplicationMenuCommandChecked('view.inspector', stateSource({ isInspectorOpen: () => false })), false);
  // density
  assert.equal(isApplicationMenuCommandChecked('view.densityCompact', stateSource({ getDensity: () => 'compact' })), true);
  assert.equal(isApplicationMenuCommandChecked('view.densityCompact', stateSource({ getDensity: () => 'comfy' })), false);
  assert.equal(isApplicationMenuCommandChecked('view.densityComfy', stateSource({ getDensity: () => 'comfy' })), true);
  assert.equal(isApplicationMenuCommandChecked('view.densityComfy', stateSource({ getDensity: () => 'compact' })), false);
  // with missing optional deps, should fallback to false/comfy without throwing
  assert.doesNotThrow(() => isApplicationMenuCommandChecked('view.inspector', stateSource({ isInspectorOpen: undefined as any })));
  assert.doesNotThrow(() => isApplicationMenuCommandChecked('view.densityCompact', stateSource({ getDensity: undefined as any })));
  // enabled still true for these (they don't require selected channel)
  assert.equal(isApplicationMenuCommandEnabled('view.browser', stateSource()), true);
  assert.equal(isApplicationMenuCommandEnabled('view.inspector', stateSource()), true);
});

test('Pointer resizing cleanup and leak prevention', () => {
  const app = appSource();
  // gutter handlers use pointer capture and window listeners
  assert.ok(app.includes('setPointerCapture'), 'uses pointer capture');
  assert.ok(app.includes('window.addEventListener(\'pointermove\''), 'adds pointermove');
  assert.ok(app.includes('window.addEventListener(\'pointerup\''), 'adds pointerup');
  assert.ok(app.includes('window.addEventListener(\'pointercancel\''), 'adds pointercancel');
  assert.ok(app.includes('window.removeEventListener(\'pointermove\''), 'removes pointermove');
  assert.ok(app.includes('window.removeEventListener(\'pointerup\''), 'removes pointerup');
  assert.ok(app.includes('window.removeEventListener(\'pointercancel\''), 'removes pointercancel');
  // activeGutterRef and isResizingRef guard
  assert.ok(app.includes('activeGutterRef.current'), 'uses activeGutterRef');
  assert.ok(app.includes('isResizingRef.current'), 'uses isResizingRef');
  // overlay to prevent leak
  assert.ok(app.includes('isResizing && ('), 'has resizing overlay');
  assert.ok(app.includes('absolute inset-0 z-30 cursor-col-resize'), 'overlay blocks pointer');
  assert.ok(app.includes("touchAction: 'none'"), 'touchAction none on gutters and overlay');
  // keyboard guard prevents stealing
  assert.ok(app.includes('activeGutterRef.current !== null || isResizingRef.current'), 'keydown guard for gutter');
});

test('Accessibility semantics for gutters', () => {
  const app = appSource();
  // browser gutter
  assert.ok(app.includes('id="apex-browser-gutter"'), 'browser gutter id');
  assert.ok(app.includes('role="separator"'), 'role separator');
  assert.ok(app.includes('aria-orientation="vertical"'), 'aria orientation');
  assert.ok(app.includes('aria-label="Resize Studio Browser"'), 'browser aria-label');
  assert.ok(app.includes('aria-valuenow={browserExpandedWidth}'), 'browser aria-valuenow');
  assert.ok(app.includes('aria-valuemin={WORKSPACE_LAYOUT_LIMITS.browser.min}'), 'browser valuemin');
  assert.ok(app.includes('aria-valuemax={WORKSPACE_LAYOUT_LIMITS.browser.max}'), 'browser valuemax');
  assert.ok(app.includes('tabIndex={isSidebarOpen ? 0 : -1}'), 'browser tabIndex respects collapsed');
  // inspector gutter
  assert.ok(app.includes('id="apex-inspector-gutter"'), 'inspector gutter id');
  assert.ok(app.includes('aria-label="Resize Inspector"'), 'inspector aria-label');
  assert.ok(app.includes('aria-valuenow={inspectorExpandedWidth}'), 'inspector aria-valuenow');
  assert.ok(app.includes('tabIndex={isInspectorOpen ? 0 : -1}'), 'inspector tabIndex');
  // focus visible styles in css
  assert.ok(indexCss().includes('#apex-browser-gutter:focus-visible'), 'browser gutter focus visible');
  assert.ok(indexCss().includes('#apex-inspector-gutter:focus-visible'), 'inspector gutter focus visible');
});

test('Small window width - main min sizing and flex handling', () => {
  const app = appSource();
  const css = indexCss();
  // main has flex-1 and min-w-[320px] for central section
  assert.ok(app.includes('className="flex-1 flex flex-col bg-[#121214] overflow-hidden min-w-[320px]"'), 'main central min 320');
  assert.ok(app.includes('id="apex-workspace-main"'), 'workspace main id');
  assert.ok(app.includes('className="flex-1 flex overflow-hidden relative"'), 'workspace main is flex-1 flex overflow-hidden');
  // browser and inspector panes are shrink-0 with fixed widths
  assert.ok(app.includes('shrink-0 flex flex-col overflow-hidden bg-[#121214] border-r'), 'browser pane shrink-0');
  assert.ok(app.includes('shrink-0 flex flex-col overflow-hidden bg-[#191c25] border-l'), 'inspector pane shrink-0');
  // gutters are shrink-0 6px
  assert.ok(app.includes('w-[6px] shrink-0'), 'gutters 6px shrink-0');
  // css has fallback for playlist label width at small breakpoints
  assert.ok(css.includes('@media (max-width: 1100px)'), 'has 1100 breakpoint');
  assert.ok(css.includes('@media (max-width: 820px)'), 'has 820 breakpoint');
  // ensure no hydration flicker: initial state reads from load* synchronously
  assert.ok(app.includes('useState(() => {'), 'initial state lazy reads localStorage synchronously');
});

test('View menu includes Browser and Inspector with correct accelerators and separators', () => {
  const menu = menuSource();
  // view menu structure
  assert.ok(menu.includes("command('view.browser'"), 'view.browser in menu def');
  assert.ok(menu.includes("command('view.inspector'"), 'view.inspector in menu def');
  assert.ok(menu.includes("command('view.densityCompact'"), 'densityCompact');
  assert.ok(menu.includes("command('view.densityComfy'"), 'densityComfy');
  // accelerator for browser is Ctrl+B, density has empty (no)
  const appMenu = APPLICATION_MENUS.find(m => m.id === 'view')!;
  const browserItem = appMenu.items.find(i => (i as any).id === 'view.browser') as any;
  assert.equal(browserItem.accelerator, 'Ctrl+B');
  // separators around browser/inspector/density
  const rawItems = menu.slice(menu.indexOf("id: 'view'"));
  assert.ok(rawItems.includes('separator'), 'has separators');
  // resolveApplicationMenuShortcut handles Ctrl+B
  assert.ok(menu.includes("event.code === 'KeyB'"), 'shortcut resolver handles B');
  assert.ok(menu.includes("return 'view.browser'"), 'returns view.browser');
});

test('Pointer resizing does not leak into editors when window width small - overlay ensures', () => {
  const app = appSource();
  // overlay is absolute inset-0 inside relative main, so it covers all panes during drag
  assert.ok(app.includes('id="apex-workspace-main" data-density={density} className="flex-1 flex overflow-hidden relative"'), 'main is relative for overlay');
  assert.ok(app.includes('isResizing && ('), 'overlay rendered only when resizing');
});
