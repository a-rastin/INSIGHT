# ADR-012: Patient Uniqueness and Demographic Fields

- **Status:** Accepted
- **Date:** 2026-08-22
- **Scope:** patient creation, duplicate prevention, birth date, age, and sex

## Context

The patient-registration workflow requires name, age, sex, and an official identifier. ADR-003 already defines the canonical UUID and deployment-configured official identifier but does not specify duplicate behavior or the stored demographic representation.

## Decision

### Duplicate prevention

The normalized official-identifier tuple `(type, issuingAuthority, value)` is a hard uniqueness boundary. Before creating a Patient, INSIGHT normalizes the submitted identifier and searches for an existing record inside the same deployment.

If a match exists, creation is rejected and the existing Patient is opened. No warning-based override, duplicate creation, or second Patient UUID is permitted. Because ADR-008 grants every Psychiatrist access to the shared patient registry, opening the existing record does not require creator ownership.

The database enforces the normalized tuple with a unique constraint so concurrent creation requests cannot produce duplicates. The application handles a uniqueness conflict by loading the winning existing record rather than retrying creation under a new identity.

### Birth date and calculated age

The Patient stores a date of birth, not a manually entered or persisted age value. Whenever an age is needed, INSIGHT calculates it from the stored date of birth and a relevant reference date. No age Snapshot is stored in the Research Case.

The current Patient profile calculates age against today's deployment-local calendar date. The Research Case, Primary Treatment Plan, Final Treatment Plan, and historical export calculate age against the Research Case start date. This preserves the patient's age at the one research workflow's start without persisting an age Snapshot.

Date of birth is mandatory for Patient creation. A partial Patient with an unknown or missing birth date cannot be saved. Date of birth is a direct identifier and must not cross the hosted-model boundary. The de-identification gateway derives and transmits only the approved age representation required by the model-visible workflow.

### Binary clinical sex

Patient creation requires one `sex` value from exactly this closed enumeration:

- `MALE`
- `FEMALE`

INSIGHT has no `INTERSEX`, `OTHER`, `UNKNOWN`, `UNSPECIFIED`, or free-text value and stores no separate gender-identity field. The UI presents only Male and Female. The selected value may be changed later through an attributable demographic correction, but every persisted Patient must always contain one of the two permitted values.

Patient creation is blocked until a valid birth date and one of the two sex values are present. The system does not create temporary incomplete patients and does not select placeholder demographic values.

### Automatic demographic overwrite on identifier match

When a submitted official identifier resolves to an existing Patient, INSIGHT compares the submitted first name, last name, date of birth, and sex with the stored values. Any difference is automatically applied to the existing Patient without warning, confirmation, or conflict-resolution review. The submitted values win as one atomic update, and the existing Patient is then opened.

The prior demographic values, new values, actor, timestamp, and source request remain in an immutable audit event. The automatic update does not create a new Patient UUID and does not change the matching normalized official identifier. This audit history supports attribution but does not prevent a mistaken or malicious submission from immediately changing the shared record used by every Psychiatrist.

This binary constraint is a selected product limitation. It cannot represent all patients or distinguish biological variables relevant to medication decisions, gender identity, anatomy, pregnancy potential, or transition-related treatment.

## Consequences

- One deployment cannot intentionally create two Patient records with the same normalized official identifier.
- Identifier normalization rules become safety-critical because a false match opens an existing record and a missed match permits a duplicate under a different normalized tuple.
- Age changes naturally with the reference date and cannot become stale as a stored integer.
- Historical reproducibility depends on consistently recalculating age against the correct historical reference date.
- A missing birth date or binary sex value prevents any Patient record from being created.
- A matching official identifier gives the newest submitted demographics authority over the existing shared record without confirmation.
- Incorrect duplicate-entry data can silently alter the name, date of birth, sex, calculated age, hosted-model inputs, and future recommendations for an existing Patient.
- Registration excludes any patient for whom neither `MALE` nor `FEMALE` is an acceptable value unless staff select an inaccurate value.
- Gender identity cannot be recorded as structured data.

## Resolved Rules

- the live profile uses today's date; Research Case artifacts use the Research Case start date;
- date of birth and binary sex are mandatory before Patient creation;
- demographics submitted with a matching official identifier automatically replace existing demographics and create an audit event.
