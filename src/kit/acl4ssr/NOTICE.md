# ACL4SSR rules — Third-party notice

The rule snapshots under `data/` are third-party content. They are bundled here
unmodified so the generated sing-box configs can carry an offline, built-in
rule set (no subscription-side rule provider needed at export time).

- Project / source:  https://github.com/ACL4SSR/ACL4SSR
- Revision (pinned): `75f0101039d71724b6e998b34604c2e053580e0c`
- License:           CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/
- Origin:            Copied from the open-source Tower (iOS) app's bundled
                     snapshot, which rewrites the upstream configs' master URLs
                     to the pinned revision above so the snapshot is
                     reproducible. File names carry the `ACL4SSR_` prefix for
                     provenance; the content is otherwise unchanged.

The built-in presets (ACL4SSR 默认 / 全分组 / 精简) mirror Tower's bundled
`ACL4SSR_Online.ini`, `ACL4SSR_Online_Full.ini` and `ACL4SSR_Online_Mini.ini`
definitions (group structure + which `.list` each routes to), re-expressed for
sing-box output.
