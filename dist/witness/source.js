"use strict";
/**
 * witness/source — the WitnessSource interface and the Witness shape (spec §4).
 * Matching a claim to a witness is conservative by design: no fuzzy matching, unmatched
 * means UNWITNESSED, not "probably fine."
 */
Object.defineProperty(exports, "__esModule", { value: true });
