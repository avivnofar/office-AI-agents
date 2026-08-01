# Verification Queue

Every UNVERIFIED section across all guides. Appended when a guide with
UNVERIFIED sections is finalized (workers/guide-engine.js's `guide_review`
path); entries are removed once the weekly `guide_verify` pass (Saturday
08:00 Israel) confirms them, via a Claude call with the web_search tool.
A guide with no queue presence is considered stable.

Format: `- guides/<domain>/<slug>.md — Section Name`

_No entries — every guide is currently stable._
