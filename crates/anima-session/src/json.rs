//! Compatibility re-export for the shared Observation/Action JSON contract.
//!
//! The implementation lives in `anima-contract-json` so native drivers and
//! the browser WASM binding cannot drift onto different schemas.

pub use anima_contract_json::{
    action_from_json, appearance_from_json, character_choice_from_json, character_prompt_to_json,
    observation_to_json, SCHEMA_VERSION,
};
