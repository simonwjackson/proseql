## ADDED Requirements

### Requirement: Entity schemas use Effect Schema.Struct
All entity schemas SHALL be defined using `Schema.Struct` from the `effect` package. Each schema SHALL produce a `Schema<Type, Encoded, never>` where `Type` is the runtime entity type and `Encoded` is the on-disk representation.

#### Scenario: Define a basic entity schema
- **WHEN** a developer defines a collection schema using `Schema.Struct({ id: Schema.String, name: Schema.String, age: Schema.Number })`
- **THEN** the schema SHALL be usable for both decoding (file → runtime) and encoding (runtime → file)

#### Scenario: Schema with optional fields
- **WHEN** a schema includes `Schema.optional(Schema.String)` for a field
- **THEN** the field SHALL be omittable in create inputs and SHALL encode as absent (not `null`) in file output

### Requirement: Schemas support bidirectional encode/decode
Every entity schema SHALL support `Schema.decodeUnknown` for parsing data from files and `Schema.encode` for serializing data back to files. Round-trip fidelity SHALL be preserved: `encode(decode(data))` MUST produce output equivalent to the original data.

#### Scenario: Load entity from JSON file
- **WHEN** a JSON file contains `{ "id": "abc", "name": "Alice", "age": 30 }`
- **THEN** `Schema.decodeUnknownSync(UserSchema)(data)` SHALL return a typed `User` object

#### Scenario: Save entity back to JSON
- **WHEN** a typed `User` object is encoded with `Schema.encodeSync(UserSchema)(user)`
- **THEN** the result SHALL be a plain object suitable for JSON serialization

#### Scenario: Round-trip fidelity
- **WHEN** data is decoded from a file and then encoded back
- **THEN** the encoded output SHALL be structurally equivalent to the original file data

### Requirement: Schema validation produces Effect ParseError
Schema validation failures SHALL produce `ParseError` from Effect Schema, not custom error types. These errors SHALL integrate with the typed error channel.

#### Scenario: Invalid data rejected on decode
- **WHEN** data missing a required field is decoded
- **THEN** a `ParseError` SHALL be produced with structured issue details including the field path and expected type

#### Scenario: Invalid data rejected on create
- **WHEN** a CRUD create operation receives data that fails schema validation
- **THEN** the operation SHALL fail with a `ValidationError` wrapping the `ParseError`

### Requirement: Collection config accepts Effect Schema
The `DatabaseConfig` type SHALL accept `Schema.Schema` instances in the `schema` field, replacing `z.ZodType`. The config SHALL infer entity types from the schema's `Type` parameter.

#### Scenario: Config type inference from schema
- **WHEN** a config defines `users: { schema: UserSchema, relationships: {} }`
- **THEN** `db.users.query()` SHALL return entities typed as `Schema.Type<typeof UserSchema>`
