# Character presets

Create one directory per character. The minimum usable package is:

```text
cyber_player/
  character.json
  idle_reference.png
```

`idle_reference.png` must be a transparent 64×64 or 128×128 PNG. Optional
`master.png`, `palette.png`, and `silhouette.png` files can be referenced from
`character.json`. Copy `_template/character.example.json` to
`<character_id>/character.json`, update it, and add the referenced images.


User-created character presets and their images stay local and are ignored by Git. Only the schema template and `diagnostic_dummy` test fixture are distributed. Create or import your own reference before production generation.
