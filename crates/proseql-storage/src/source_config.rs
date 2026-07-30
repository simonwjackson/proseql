use globset::{Glob, GlobSetBuilder};
use indexmap::IndexMap;
use proseql_engine::errors::{EngineError, SourceConfigError};

use crate::path::{join_path, normalize_path, relative_to_root};
use crate::persistence::CollectionStorageConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceCollectionSelection {
    All,
    Named(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownCollectionPolicy {
    Error,
    Preserve,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentSourceStrictness {
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentGraphFragmentErrorPolicy {
    Error,
    SkipFragment,
    SkipRoot,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentSourceConfig {
    pub id: String,
    pub root: String,
    pub include: Option<Vec<String>>,
    pub exclude: Vec<String>,
    pub format: Option<String>,
    pub collections: Option<SourceCollectionSelection>,
    pub unknown_collections: UnknownCollectionPolicy,
    pub outbox: String,
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentGraphRootConfig {
    pub id: Option<String>,
    pub root: String,
    pub optional: bool,
    pub include: Option<Vec<String>>,
    pub exclude: Vec<String>,
    pub collections: Option<SourceCollectionSelection>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentGraphSourceConfig {
    pub id: String,
    pub roots: Vec<DocumentGraphRootConfig>,
    pub collections: Option<SourceCollectionSelection>,
    pub include: Option<Vec<String>>,
    pub exclude: Vec<String>,
    pub transform_callback_id: Option<String>,
    pub on_fragment_error: DocumentGraphFragmentErrorPolicy,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DatabaseSourceConfig {
    Documents(DocumentSourceConfig),
    DocumentGraph(DocumentGraphSourceConfig),
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceConfigInput {
    pub collections: IndexMap<String, CollectionStorageConfig>,
    pub sources: Vec<DatabaseSourceConfig>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedDocumentSourceConfig {
    pub id: String,
    pub root: String,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub format: String,
    pub collections: Vec<String>,
    pub unknown_collections: UnknownCollectionPolicy,
    pub duplicates: DocumentSourceStrictness,
    pub outbox: String,
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedDocumentGraphRootConfig {
    pub id: String,
    pub root: String,
    pub optional: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub collections: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedDocumentGraphSourceConfig {
    pub id: String,
    pub roots: Vec<NormalizedDocumentGraphRootConfig>,
    pub collections: Vec<String>,
    pub transform_callback_id: Option<String>,
    pub on_fragment_error: DocumentGraphFragmentErrorPolicy,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NormalizedDatabaseSourceConfig {
    Documents(NormalizedDocumentSourceConfig),
    DocumentGraph(NormalizedDocumentGraphSourceConfig),
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedSourceConfig {
    pub collections: Vec<String>,
    pub collection_configs: IndexMap<String, CollectionStorageConfig>,
    pub sources: Vec<NormalizedDatabaseSourceConfig>,
}

fn source_config_error(
    message: impl Into<String>,
    source_id: Option<String>,
    collection: Option<String>,
    path: Option<String>,
) -> EngineError {
    EngineError::SourceConfig(Box::new(SourceConfigError {
        message: message.into(),
        source_id,
        collection,
        path,
    }))
}

fn selection_to_vec(selection: &Option<SourceCollectionSelection>, all: &[String]) -> Vec<String> {
    match selection {
        None | Some(SourceCollectionSelection::All) => all.to_vec(),
        Some(SourceCollectionSelection::Named(values)) => {
            let mut values = values.clone();
            values.sort();
            values
        }
    }
}

fn default_includes_for_format(format: &str) -> Vec<String> {
    if format == "yaml" {
        vec!["**/*.yaml".to_owned(), "**/*.yml".to_owned()]
    } else {
        vec![format!("**/*.{format}")]
    }
}

pub fn matches_document_source_pattern(
    source: &NormalizedDocumentSourceConfig,
    path: &str,
) -> bool {
    let relative = relative_to_root(&source.root, path);
    if relative == ".." || relative.starts_with("../") {
        return false;
    }
    let included = source
        .include
        .iter()
        .any(|pattern| matches_document_pattern(pattern, &relative));
    included
        && !source
            .exclude
            .iter()
            .any(|pattern| matches_document_pattern(pattern, &relative))
}

fn matches_document_pattern(pattern: &str, relative_path: &str) -> bool {
    let Ok(normalized_pattern) = normalize_glob_pattern(pattern) else {
        return false;
    };
    if normalized_pattern == "**/*" {
        return !relative_path.is_empty();
    }
    if let Some(suffixes) = extension_suffixes(&normalized_pattern, "**/*.") {
        return suffixes
            .iter()
            .any(|suffix| relative_path.ends_with(&format!(".{suffix}")));
    }
    if let Some(suffixes) = extension_suffixes(&normalized_pattern, "*.") {
        return !relative_path.contains('/')
            && suffixes
                .iter()
                .any(|suffix| relative_path.ends_with(&format!(".{suffix}")));
    }
    if let Some(prefix) = normalized_pattern.strip_suffix("/*") {
        if let Some(rest) = relative_path.strip_prefix(prefix) {
            let rest = rest.trim_start_matches('/');
            return !rest.is_empty() && !rest.contains('/');
        }
        return false;
    }
    Glob::new(&normalized_pattern)
        .map(|glob| glob.compile_matcher().is_match(relative_path))
        .unwrap_or(false)
}

fn extension_suffixes<'a>(pattern: &'a str, prefix: &str) -> Option<Vec<&'a str>> {
    let suffix = pattern.strip_prefix(prefix)?;
    if suffix.starts_with('{') && suffix.ends_with('}') {
        Some(
            suffix[1..suffix.len() - 1]
                .split(',')
                .filter(|part| !part.is_empty())
                .collect(),
        )
    } else {
        Some(vec![suffix])
    }
}

pub fn matches_any_glob(relative_path: &str, patterns: &[String]) -> bool {
    if relative_path == ".." || relative_path.starts_with("../") {
        return false;
    }
    let Ok(glob_set) = compile_glob_set(patterns) else {
        return false;
    };
    glob_set.is_match(relative_path)
}

fn normalize_glob_pattern(pattern: &str) -> Result<String, String> {
    let normalized = normalize_path(pattern);
    let chars = normalized.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        if matches!(ch, '@' | '!' | '?' | '+' | '*') && chars.get(index + 1) == Some(&'(') {
            if ch != '@' {
                return Err(format!(
                    "unsupported picomatch extglob '{}(' in pattern '{}'",
                    ch, pattern
                ));
            }
            let start = index + 2;
            let mut depth = 1;
            let mut cursor = start;
            while cursor < chars.len() {
                match chars[cursor] {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                cursor += 1;
            }
            if depth != 0 {
                return Err(format!("unterminated extglob in pattern '{pattern}'"));
            }
            let body = chars[start..cursor].iter().collect::<String>();
            output.push('{');
            output.push_str(&body.replace('|', ","));
            output.push('}');
            index = cursor + 1;
            continue;
        }
        output.push(ch);
        index += 1;
    }

    Ok(output)
}

fn compile_glob_set(patterns: &[String]) -> Result<globset::GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let normalized = normalize_glob_pattern(pattern)?;
        builder.add(Glob::new(&normalized).map_err(|error| error.to_string())?);
    }
    builder.build().map_err(|error| error.to_string())
}

fn validate_glob_patterns(
    patterns: &[String],
    source_id: &str,
    label: &str,
    path: Option<&str>,
) -> Result<(), EngineError> {
    compile_glob_set(patterns).map(|_| ()).map_err(|error| {
        source_config_error(
            format!("Source '{source_id}' has invalid {label} pattern: {error}"),
            Some(source_id.to_owned()),
            None,
            path.map(str::to_owned),
        )
    })
}

pub fn normalize_source_config(
    input: SourceConfigInput,
) -> Result<NormalizedSourceConfig, EngineError> {
    let mut collection_names = input.collections.keys().cloned().collect::<Vec<_>>();
    collection_names.sort();
    let collection_name_set = collection_names
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let mut source_ids = std::collections::HashSet::new();
    let mut outboxes = std::collections::HashMap::new();
    let mut owners = std::collections::HashMap::new();
    let mut sources = Vec::new();

    for source in input.sources {
        match source {
            DatabaseSourceConfig::Documents(source) => {
                if !source_ids.insert(source.id.clone()) {
                    return Err(source_config_error(
                        format!("Duplicate source id '{}'", source.id),
                        Some(source.id),
                        None,
                        None,
                    ));
                }
                let selected = selection_to_vec(&source.collections, &collection_names);
                for collection in &selected {
                    if !collection_name_set.contains(collection) {
                        return Err(source_config_error(
                            format!(
                                "Source '{}' references undeclared collection '{}'",
                                source.id, collection
                            ),
                            Some(source.id.clone()),
                            Some(collection.clone()),
                            None,
                        ));
                    }
                    if let Some(existing) = owners.insert(collection.clone(), source.id.clone()) {
                        return Err(source_config_error(
                            format!(
                                "Collection '{}' is backed by both document sources '{}' and '{}'",
                                collection, existing, source.id
                            ),
                            Some(source.id.clone()),
                            Some(collection.clone()),
                            None,
                        ));
                    }
                }
                let format = source.format.unwrap_or_else(|| "yaml".to_owned());
                let normalized = NormalizedDocumentSourceConfig {
                    id: source.id.clone(),
                    root: normalize_path(&source.root)
                        .trim_end_matches('/')
                        .to_owned(),
                    include: source
                        .include
                        .unwrap_or_else(|| default_includes_for_format(&format)),
                    exclude: source.exclude,
                    format,
                    collections: selected,
                    unknown_collections: source.unknown_collections,
                    duplicates: DocumentSourceStrictness::Error,
                    outbox: join_path(&source.root, &source.outbox),
                    optional: source.optional,
                };
                validate_glob_patterns(
                    &normalized.include,
                    &normalized.id,
                    "include",
                    Some(&normalized.root),
                )?;
                validate_glob_patterns(
                    &normalized.exclude,
                    &normalized.id,
                    "exclude",
                    Some(&normalized.root),
                )?;
                if !matches_document_source_pattern(&normalized, &normalized.outbox) {
                    return Err(source_config_error(
                        format!("Document source '{}' outbox '{}' is not rediscoverable by its include patterns", normalized.id, normalized.outbox),
                        Some(normalized.id.clone()),
                        None,
                        Some(normalized.outbox.clone()),
                    ));
                }
                if let Some(existing) =
                    outboxes.insert(normalized.outbox.clone(), normalized.id.clone())
                {
                    return Err(source_config_error(
                        format!(
                            "Document source outbox '{}' is owned by both '{}' and '{}'",
                            normalized.outbox, existing, normalized.id
                        ),
                        Some(normalized.id.clone()),
                        None,
                        Some(normalized.outbox.clone()),
                    ));
                }
                sources.push(NormalizedDatabaseSourceConfig::Documents(normalized));
            }
            DatabaseSourceConfig::DocumentGraph(source) => {
                if !source_ids.insert(source.id.clone()) {
                    return Err(source_config_error(
                        format!("Duplicate source id '{}'", source.id),
                        Some(source.id),
                        None,
                        None,
                    ));
                }
                let selected = selection_to_vec(&source.collections, &collection_names);
                let selected_set = selected
                    .iter()
                    .cloned()
                    .collect::<std::collections::HashSet<_>>();
                for collection in &selected {
                    if !collection_name_set.contains(collection) {
                        return Err(source_config_error(
                            format!(
                                "Source '{}' references undeclared collection '{}'",
                                source.id, collection
                            ),
                            Some(source.id.clone()),
                            Some(collection.clone()),
                            None,
                        ));
                    }
                    if let Some(existing) = owners.insert(collection.clone(), source.id.clone()) {
                        return Err(source_config_error(
                            format!(
                                "Collection '{}' is backed by both sources '{}' and '{}'",
                                collection, existing, source.id
                            ),
                            Some(source.id.clone()),
                            Some(collection.clone()),
                            None,
                        ));
                    }
                }
                let graph_include = source.include.clone();
                let graph_exclude = source.exclude.clone();
                if let Some(include) = &graph_include {
                    validate_glob_patterns(include, &source.id, "include", None)?;
                }
                validate_glob_patterns(&graph_exclude, &source.id, "exclude", None)?;
                let normalized_roots = source
                    .roots
                    .into_iter()
                    .enumerate()
                    .map(|(index, root)| {
                        let include = root.include.clone().or_else(|| graph_include.clone()).ok_or_else(|| {
                            source_config_error(
                                format!(
                                    "Document graph source '{}' root '{}' has no include pattern; provide a graph-level or root-level include",
                                    source.id, root.root
                                ),
                                Some(source.id.clone()),
                                None,
                                Some(root.root.clone()),
                            )
                        })?;
                        if include.is_empty() {
                            return Err(source_config_error(
                                format!(
                                    "Document graph source '{}' root '{}' has no include pattern; provide a graph-level or root-level include",
                                    source.id, root.root
                                ),
                                Some(source.id.clone()),
                                None,
                                Some(root.root.clone()),
                            ));
                        }
                        validate_glob_patterns(&include, &source.id, "include", Some(&root.root))?;
                        let mut exclude = graph_exclude.clone();
                        exclude.extend(root.exclude.clone());
                        validate_glob_patterns(&exclude, &source.id, "exclude", Some(&root.root))?;
                        let root_collections = selection_to_vec(&root.collections, &selected);
                        for collection in &root_collections {
                            if !selected_set.contains(collection) {
                                return Err(source_config_error(
                                    format!("Document graph source '{}' root '{}' references collection '{}' outside the graph source collections", source.id, root.root, collection),
                                    Some(source.id.clone()),
                                    Some(collection.clone()),
                                    Some(root.root.clone()),
                                ));
                            }
                        }
                        Ok(NormalizedDocumentGraphRootConfig {
                            id: root.id.unwrap_or_else(|| format!("{}:{index}", source.id)),
                            root: normalize_path(&root.root).trim_end_matches('/').to_owned(),
                            optional: root.optional,
                            include,
                            exclude,
                            collections: root_collections,
                        })
                    })
                    .collect::<Result<Vec<_>, EngineError>>()?;
                sources.push(NormalizedDatabaseSourceConfig::DocumentGraph(
                    NormalizedDocumentGraphSourceConfig {
                        id: source.id,
                        roots: normalized_roots,
                        collections: selected,
                        transform_callback_id: source.transform_callback_id,
                        on_fragment_error: source.on_fragment_error,
                    },
                ));
            }
        }
    }

    Ok(NormalizedSourceConfig {
        collections: collection_names,
        collection_configs: input.collections,
        sources,
    })
}
