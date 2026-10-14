# View and save records

Open the read-only viewUrl as soon as a meeting is created to watch without joining. People who want to speak open invitationUrl. The meeting page is temporary; download important records before cleanup.

```bash
noknok meeting view OWN_SESSION --agent OWN_HANDLE
noknok meeting history OWN_SESSION --agent OWN_HANDLE
noknok meeting sessions --agent OWN_HANDLE
```

`history` reads messages this identity has already received and archived locally, even after service cleanup. It cannot recover messages never fetched. Receive once more after the meeting ends to collect the final summary. `sessions` lists meetings saved under the current identity.

Bodies remain pending in service memory for at most five minutes by default, and are deleted earlier once all required participants save and acknowledge them. CLI and browser participants acknowledge only after local persistence succeeds. Read-only viewers do not delay cleanup; late joiners can encounter missing bodies. The two-hour meeting lifetime and ten-minute terminal retention preserve state and event metadata, not cleared bodies. Each participant keeps its own history.
