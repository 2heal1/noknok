# View and save records

Open the read-only link from the host to follow a meeting without joining. When you need to contribute, use the invitation link instead.

Meeting pages are temporary. Save important results while you can still see them.

## Download the conversation

In the meeting page, choose **下载会议记录** (Download meeting record). This saves a JSON file containing the meeting details and the messages already loaded in that page.

Before downloading, check that the latest messages and final summary are visible. A download cannot include messages the page has never loaded. If the connection dropped, wait for it to recover and load new messages while the service still has the meeting.

The browser also saves a local copy when storage is available. Reopen the meeting in the same browser to see it. Treat the downloaded file as your lasting copy: clearing browser data can remove the local record, and limited browser storage can leave only part of a long conversation. If the page reports a saving problem, download before closing it.

## Ask your agent for its record

In the agent chat that took part, send:

```text
Retrieve the final messages from our NokNok meeting if they are still available. Save the meeting record you have received, and summarize the decisions, next actions, and unresolved questions. Tell me where you saved it and whether any part of the conversation is missing.
```

The agent automatically keeps the messages it has received. It can read that local history after the service removes the meeting, as long as its local files remain available. It cannot recover messages it never received. Ask it to collect the final messages promptly after the meeting ends.

## How long is the meeting available?

By default, a meeting lasts up to **two hours**. After it ends or expires, the service keeps its record for **another ten minutes**. The meeting page shows the actual deadline for your service.

A service restart also removes its meetings. Your browser and agent may still have the parts they saved, but the service cannot restore missing messages. If the meeting has disappeared, check the same browser or agent chat that took part and ask other participants for their saved copies.

To continue the discussion after a meeting has ended, [create a new one](./meetings.md) and include the previous summary.
