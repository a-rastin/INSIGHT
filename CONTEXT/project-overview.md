This file's name: "project-overview.md"

# Project INSIGHT

## Overview

INSIGHT is an explainable decision support application, using a MCP server to connect a MCP client to a database. This app uses Bayesian Networks to make explainable decisions.

## Goals

1. Generate reproducible and explainable decision support.

## Core User Flow

1. An "administrator" provisions and manages user accounts, system configuration,  knowledge artifacts, logs, and backups; a "user" signs in through the Authentication module.
2. The "user" reviews and checks the research-use disclaimer before the first time entering the  workspace.
3. The "user" creates or locates a sample through the "Add New Patient" module. The system resolves the sample to one canonical sample UUID.
4. The "user" (psychiatrist) opens a new dated Encounter for an initial assessment or follow-up visit.
5. Eligible cases are evaluated through the "DDI service", and the " Bayesian-network pathways".
6. At the end, "INSIGHT" produces an explainable "Primary Treatment Plan" covering the supported treatment-setting, pharmacotherapy, and follow-up recommendations.
7. The "user" (psychiatrist) reviews the recommendation evidence and accepts or modifies the draft, and provides rationale where he/she wants. Medication changes trigger renewed DDI checks before finalization.
8. The "user" (psychiatrist) approves the plan. INSIGHT stores an attributable, immutable Final Treatment Plan with the original recommendation, all edits, overrides, evidence, model and knowledge versions.

## Clinical Workflow and Sample (Patient) Records

1. Role-based workspaces for "admin" and "users" (psychiatrists).
2. Canonical patient identity with a UUID.
3. A multi steps "Add New Patient" module with these steps:
   - ID extraction step (Name, Age, Sex)
   - Structured schizophrenia diagnostic checklist, while preserving explicit psychiatrist confirmation or bypass; computed results must not overwrite the psychiatrist's diagnosis.
   - PANSS assessment covering the 30 positive, negative, and general psychopathology items, with total and subscale calculations derived from item responses, while preserving explicit psychiatrist  bypass.
   - Baseline and medical-history capture, including physical and laboratory information, medications, prior antipsychotic treatment and response, adherence concerns, contraindications.

## Decision Support and Clinical Safety

- A Treatment Plan orchestrator that assembles versioned data from Authentication, Patient, Diagnosis, Severity, Medical History, DDI, and BN Manager services.
- Drug-drug interaction evaluation using normalized medication identities.
- Versioned Bayesian-network and influence-diagram support for candidate pathways represented in the archive, including:
  1. treatment setting;
  2. pharmacotherapy selection;
  3. involuntary-treatment considerations;
  4. clozapine pathways for treatment resistance, substantial suicide risk, and persistent aggressive behavior;
  5. continuation and maintenance of antipsychotic treatment;
  6. long-acting injectable antipsychotic considerations;
- Visible recommendation evidence linking outputs to input facts.

## Psychiatrist Review, Finalization, and Follow-up

- Explainable Primary Treatment Plan presented as a system-generated draft rather than a prescription or clinical order.
- Structured review workspace that preserves the original recommendation while showing psychiatrist changes as an explicit diff.
- Re-execution of DDI checks after clinically relevant edits and immediately before finalization.
- Idempotent finalization producing an immutable and attributable Final Treatment Plan.

## Platform Architecture

- A unified deployment option in one Docker image.

## Administrator

- Add new users, define and change usernames and passwords (primary user/pass for administrator is admin/admin andn there is no primary user account).
- Knowledge-base and Bayesian-model validation, review, activation, versioning, and rollback controls.
- Audit, chat-log, and operational-log access.
- Backup, restore, migration, environment configuration, health checks, graceful shutdown, and deployment rollback procedures.





Step 1 - ID

- First Name | Only English words | [Mandatory]

- Last Name | Only English words | [Mandatory] 

- Age (asks for year of birth and calculates the age) | 4 digit number | Only 18 to 99 year old is accepted | [Mandatory]

- Sex (Male or Female) | [Mandatory] | drop down menu

- National Code (10 digit number) | [Mandatory]

Step 2 - Diagnosis

- Diagnosis criteria of schizophrenia based on DSM-5-TR

- user checks the items and system calculats the result.

- user can pass the criteria

Step 3 - PANSS

- Schizophrenia severity index

-user checks the items and system calculates the results

- user can pass the PANSS and does not check

Step 4 - Medical history

- is the patient new case or a known case? | [Mandatory]

- What are patients comorbidities? | drop down menue | mandatory

- a mcp server normalizes the name of medications by providing the data to llm and asking for normalized names.

Step 5 - Primary treatment plan

- a mcp server provides llm with data from previous 

- a drug drug interaction checker looks for interactions in patients drugs (if present) and recommended drugs from bayesian engine.

Step 6 - Final treatment Plan