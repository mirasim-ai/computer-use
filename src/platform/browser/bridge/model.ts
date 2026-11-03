/**
 * Portions Copyright (c) Microsoft Corporation (Playwright), licensed under the Apache License,
 * Version 2.0; modified by MIRASIM, INC. See LICENSE and NOTICE.
 *
 * `BridgeModel` — the extension bridge's model, as one class made of two halves.
 *
 * `model-core.ts` holds its state and everything the EXTENSION pushes into it; `model-commands.ts`
 * holds what a CLIENT may ask of it. This file is where the halves meet, so neither imports the
 * other back (an ES module cycle would break the `extends` at load time).
 */

import { BridgeModelCommands } from "./model-commands.ts";

export {   type CdpMessage } from "./client.ts";

export class BridgeModel extends BridgeModelCommands {}
