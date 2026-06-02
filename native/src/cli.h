#pragma once

// Standalone CLI mode: reproduces bin/starfish-cdp.mjs (start/stop/status +
// eval/cdp/text/html/goto/click/type/screenshot) in C++, without Node. Each
// command connects to the already-running managed Starfish, performs one
// action, prints a result, and disconnects (never closing Starfish).
//
// Returns the process exit code.
int runCli(int argc, char** argv);
