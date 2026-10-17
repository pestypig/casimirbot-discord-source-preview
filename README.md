# CasimirBot Discord transport source preview

This MIT-licensed source-only snapshot contains 24 selected TypeScript files from CasimirBot's Discord integration at private platform commit `7ab2e54d872cebffb050552d87d58f1b1bcd2549`. The [exact inventory](SOURCE_SELECTION.json) records each file's SHA-256 and byte length and two files excluded because they import unpublished server modules.

## What is here

- Discord command transport and profile-link request source.
- A persistent voice-worker transport, admission, bridge, roster, and packet helpers with selected tests.
- Source references to domain APIs and to modules that are not bundled in this preview.

The domain owns account, invitation, room, and participant-consent authority. This snapshot includes no bot credentials or hosted access. A source file, fixture, or local worker test is not evidence of accepted live voice, transcription, playback, or public account access.

## Build and integration status

This is **not a standalone bot package or supported deployment**. The original package metadata depends on the private platform root and is intentionally omitted, as are the lockfile, deployment configuration, server modules, and live account settings. The selected TypeScript files parse and have no unclosed relative or repository-root static imports. No independent build or live behavior is promised by this snapshot.

External packages such as Discord.js, @discordjs/voice, OpusScript, and ws are not bundled. Resolve their upstream licenses and service terms when integrating; see [dependency notices](THIRD_PARTY_NOTICES.md).

## Source boundary and license

The selected source files are byte-identical to the committed platform source named in `SOURCE_SELECTION.json`. This clean-history snapshot omits current dirty worktree files, profile data, deployment settings, credentials, and platform Git history. It does not grant access to hosted services or private developer controls. The first-party content here is released under the [MIT License](LICENSE).
