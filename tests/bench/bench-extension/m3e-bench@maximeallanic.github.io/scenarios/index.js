// Scenario registry: name -> async (scene) => result. Suites (lists of names) are in suites.json at the bench root
// and used by run.sh; this module only knows how to run a name.
import {engineSpringScenarios} from './engine-springs.js';
import {engineStateScenarios} from './engine-state.js';
import {patternBasicScenarios} from './patterns-basic.js';
import {patternLifecycleScenarios} from './patterns-lifecycle.js';
import {windowScenarios} from './windows.js';
import {workspaceOverviewScenarios} from './workspaces-overview.js';
import {surfaceScenarios} from './surfaces.js';
import {systemScenarios} from './system.js';
import {shadeScenarios} from './shade.js';
import {componentScenarios} from './components.js';
import {lifecycleScenarios} from './lifecycle.js';
import {extensionScenarios} from './extensions.js';
import {statusBarScenarios} from './status-bar.js';

export const SCENARIOS = {
    ...engineSpringScenarios,
    ...engineStateScenarios,
    ...patternBasicScenarios,
    ...patternLifecycleScenarios,
    ...windowScenarios,
    ...workspaceOverviewScenarios,
    ...surfaceScenarios,
    ...systemScenarios,
    ...shadeScenarios,
    ...componentScenarios,
    ...lifecycleScenarios,
    ...extensionScenarios,
    ...statusBarScenarios,
};

const motionScenarios = {
    ...windowScenarios, ...workspaceOverviewScenarios, ...surfaceScenarios, ...systemScenarios,
    ...shadeScenarios, ...componentScenarios, ...lifecycleScenarios,
};

// Scenarios that need the Shell reset first (overview closed, workspace 0, no slow-down): the ones that drive the
// real window manager of the nested Shell.
export const NEEDS_SETTLED_SHELL = new Set(Object.keys(motionScenarios));
