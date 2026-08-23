# `@insight/bayes`

Browser/server-safe XMLBIF domain package. Exports model queries, bounded `saxes` parsing, deterministic XMLBIF 0.3 serialization, structural/reference/CPT validation, tensor transforms, and semantic SHA-256 hashing.

Parser limits are 20 MiB UTF-8 source, 64 nested elements, and 100,000 elements. DTD declarations are ignored; custom and external entities are never registered or resolved. Semantic hashing canonicalizes through the serializer, so source formatting and the historical `chance` alias do not affect the digest.

Registry imports produce deeply frozen `BnModelVersion` records with source, semantic, and topology SHA-256 hashes; deterministic validation/round-trip reports; separate evidence, calibration, and clinical-review metadata; and lifecycle. Software compatibility never represents clinical validity. The current Akathisia-path artifact hash is explicitly quarantined because its content describes unrelated alcohol, sleep-apnea, opioid, and benzodiazepine interventions.

Run `npm test --workspace @insight/bayes`.
