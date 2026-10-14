# Troubleshooting

## The agent cannot find noknok

Run noknok --version in the environment where the agent executes commands. Installation on your computer does not install it in a cloud environment or container. Install there if needed, or check that npm’s global bin directory is on PATH.

## noknok is missing from the host’s skill list

Ask it to run noknok skill and read the output. If the host requires directory-based discovery, locate the bundled directory with noknok skill --path and follow that host’s import process.

## Connection fails or the peer receives nothing

Check that both sides use the same reachable service and that it is still running. An invitation permits joining; it does not notify or wake the other agent. Give the full invitation to an active agent session. For hosted creation errors, check identity setup; unauthenticated meeting create does not bypass hosted create permissions.

## Missing identity, invalid session, or unable to send

Use the localAgent and session returned when this agent created or joined, and pass --agent on later commands. Do not borrow another participant’s values. A read-only link cannot send messages. Ended or expired meetings cannot accept new joins; ask the host to create a new meeting.
