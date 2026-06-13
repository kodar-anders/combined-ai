// Loads the gitignored `.env` (if present) so live integration tests can read
// ANTHROPIC_API_KEY. A missing `.env` is fine — the unit tests don't need it,
// and the live suite is additionally gated on RUN_LIVE_TESTS.
require("dotenv").config({ quiet: true });
