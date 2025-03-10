## Description
<!-- Describe your changes in detail -->

## Related Issue(s)
<!-- List the issue(s) this PR solves -->
Fixes #

## How to test
<!-- Provide steps to test this PR -->

## Documentation
<!--
Does this PR require updates to the documentation at www.gitpod.io/docs?
* Yes
  * 1. Please create a docs issue: https://github.com/gitpod-io/website/issues/new?labels=documentation&template=DOCS-NEW-FEATURE.yml&title=%5BDocs+-+New+Feature%5D%3A+%3Cyour+feature+name+here%3E
  * 2. Paste the link to the docs issue below this comment
* No
  * Are you sure? If so, nothing to do here.
-->

#### Preview status

gitpod:summary

## Build Options:

- [ ] /werft with-werft
      Run the build with werft instead of GHA
- [ ] leeway-no-cache
- [ ] /werft no-test
      Run Leeway with `--dont-test`

<details>
<summary>Publish Options</summary>

- [ ] /werft publish-to-npm
- [ ] /werft publish-to-jb-marketplace
</details>

<details>
<summary>Installer Options</summary>

- [ ] analytics=segment
- [ ] with-dedicated-emulation
- [ ] with-ws-manager-mk2
- [ ] workspace-feature-flags
  Add desired feature flags to the end of the line above, space separated
</details>

#### Preview Environment Options:
- [ ] /werft with-local-preview
      If enabled this will build `install/preview`
- [ ] /werft with-preview
- [ ] /werft with-large-vm
- [ ] /werft with-gce-vm
      If enabled this will create the environment on GCE infra
- [ ] with-integration-tests=all
      Valid options are `all`, `workspace`, `webapp`, `ide`, `jetbrains`, `vscode`, `ssh`

/hold
