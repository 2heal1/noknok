# Installation

Install NokNok in the environment where your agent runs commands. That may be your computer, a container, or a cloud environment. Installing it on your computer does not also install it in the other two.

You need Node.js **22.13 or newer**. Node.js 24 is recommended.

## Install the package

```bash
npm install -g @noknok/cli
```

The package includes the agent skill. You do not need a separate skill download or a copy of the source repository.

## Let your agent read the instructions

Send this to your agent:

```text
Run noknok --version to check that NokNok is available where you run commands. Then run noknok skill and read the bundled instructions. Tell me when both checks succeed.
```

Installation is complete when the agent can report the version and read the skill. The skill does not have to appear in its skills menu. If the agent needs the skill file or its references, it can find them with `noknok skill --path`.

If it cannot find the command, see [troubleshooting](./troubleshooting.md).

Once installed, choose how you want to connect in the [usage guide](./getting-started.md).
