# @schalkneethling/skills-autoresearch

An installable command-line harness for evaluating and improving agent skills with repeatable fixtures and auditable artifacts.

The package provides two commands:

- `skills-autoresearch` runs the application CLI, including recorded-response determinization.
- `skills-autoresearch-flue` runs the Flue-backed smoke, research, and determinization workflows.

Run either command with `--help` for its complete options. Skills Autoresearch requires Node.js 24 or newer. Model-backed commands use locally supplied model credentials; credential-free smoke and recorded-response workflows do not require them.

Repository development, fixture authoring, and contributor documentation remain in the [Skills Autoresearch repository](https://github.com/schalkneethling/skills-autoresearch-flue).
