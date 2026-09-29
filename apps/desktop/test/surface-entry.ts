import { PettyTerminal } from '../src/renderer/petty-terminal'

// Export to the classic script served by the Electron surface smoke harness.
Object.assign(window, { PettySurfaceTest: { PettyTerminal } })
