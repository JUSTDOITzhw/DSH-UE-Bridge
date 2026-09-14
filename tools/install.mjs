#!/usr/bin/env node
/**
 * Back-compat shim.
 *
 * The installer used to live here; it now ships as the package's `bin` entry so
 * that `npx dsh-ue-bridge` and a checkout of the repo behave identically. This
 * file stays so existing notes, scripts and `tools/install.cmd|sh` keep working.
 *
 *   node tools/install.mjs              -> node bin/cli.mjs install
 *   node tools/install.mjs --uninstall  -> node bin/cli.mjs uninstall
 */
import '../bin/cli.mjs'
