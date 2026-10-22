pub mod codecs;
pub mod prose;

use std::sync::Arc;

use proseql_engine::callbacks::CallbackRegistry;
pub use proseql_engine::errors::{SerializationError, UnsupportedFormatError};
use proseql_engine::plugins::PluginCodecMetadata;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FormatOptions {
    pub indent: Option<usize>,
}

pub trait FormatCodec: Send + Sync {
    fn name(&self) -> &str;
    fn extensions(&self) -> &[&str];
    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String>;
    fn decode(&self, raw: &str) -> Result<Value, String>;

    /// Whether `decode(encode(value))` must give `value` back.
    ///
    /// When this is true and the registry's write check is on,
    /// [`FormatRegistry::serialize`] decodes every encoding before it
    /// returns it, and refuses an encoding that does not read back to the
    /// same value. Every durable write of a codec's output goes through
    /// `serialize`, so a broken encoder cannot leave a file that this codec
    /// cannot open. Lossy codecs (TOML drops nulls, Prose keeps a template)
    /// keep the default `false`.
    fn round_trips_exactly(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FormatRegistryError {
    Serialization(SerializationError),
    UnsupportedFormat(UnsupportedFormatError),
}

pub struct FormatRegistry {
    codecs: Vec<Box<dyn FormatCodec>>,
    extension_map: indexmap::IndexMap<String, usize>,
    supported_extensions: Vec<String>,
    write_check: bool,
}

struct CallbackFormatCodec {
    callbacks: Arc<CallbackRegistry>,
    metadata: PluginCodecMetadata,
}

impl FormatCodec for CallbackFormatCodec {
    fn name(&self) -> &str {
        self.metadata.name.as_str()
    }

    fn extensions(&self) -> &[&str] {
        unreachable!("callback codec extensions are provided via owned cache")
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        self.callbacks
            .invoke_codec_encode(
                self.metadata.encode_callback_id.as_str(),
                data,
                options.and_then(|value| value.indent),
            )
            .ok_or_else(|| {
                format!(
                    "Plugin codec '{}' encode callback '{}' is not registered",
                    self.metadata.name, self.metadata.encode_callback_id
                )
            })?
            .map_err(|error| error.to_string())
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        self.callbacks
            .invoke_codec_decode(self.metadata.decode_callback_id.as_str(), raw)
            .ok_or_else(|| {
                format!(
                    "Plugin codec '{}' decode callback '{}' is not registered",
                    self.metadata.name, self.metadata.decode_callback_id
                )
            })?
            .map_err(|error| error.to_string())
    }
}

struct OwnedExtensionsCodec {
    inner: Box<dyn FormatCodec>,
    borrowed_extensions: Vec<&'static str>,
}

impl OwnedExtensionsCodec {
    fn new(inner: Box<dyn FormatCodec>, extensions: Vec<String>) -> Self {
        let borrowed_extensions = extensions
            .iter()
            .cloned()
            .map(|ext| Box::leak(ext.into_boxed_str()) as &'static str)
            .collect();
        let _ = extensions;
        Self {
            inner,
            borrowed_extensions,
        }
    }
}

impl FormatCodec for OwnedExtensionsCodec {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn extensions(&self) -> &[&str] {
        &self.borrowed_extensions
    }

    fn encode(&self, data: &Value, options: Option<FormatOptions>) -> Result<String, String> {
        self.inner.encode(data, options)
    }

    fn decode(&self, raw: &str) -> Result<Value, String> {
        self.inner.decode(raw)
    }

    fn round_trips_exactly(&self) -> bool {
        self.inner.round_trips_exactly()
    }
}

pub fn plugin_codec(
    callbacks: Arc<CallbackRegistry>,
    metadata: &PluginCodecMetadata,
) -> impl FormatCodec {
    OwnedExtensionsCodec::new(
        Box::new(CallbackFormatCodec {
            callbacks,
            metadata: metadata.clone(),
        }),
        metadata.extensions.clone(),
    )
}

pub fn format_registry_with_plugin_codecs(
    callbacks: Arc<CallbackRegistry>,
    plugin_codecs: &[PluginCodecMetadata],
) -> FormatRegistry {
    let mut codecs: Vec<Box<dyn FormatCodec>> = vec![
        Box::new(codecs::json_codec()),
        Box::new(codecs::yaml_codec()),
        Box::new(codecs::toml_codec()),
        Box::new(codecs::json5_codec()),
        Box::new(codecs::jsonc_codec()),
        Box::new(codecs::jsonl_codec()),
        Box::new(codecs::hjson_codec()),
        Box::new(codecs::toon_codec()),
        Box::new(codecs::prose_codec(None, vec![])),
    ];
    for metadata in plugin_codecs {
        codecs.push(Box::new(plugin_codec(Arc::clone(&callbacks), metadata)));
    }

    let mut registry = FormatRegistry::new(codecs);
    let mut supported_extensions = Vec::new();
    for metadata in plugin_codecs {
        for extension in &metadata.extensions {
            if !supported_extensions
                .iter()
                .any(|candidate| candidate == extension)
            {
                supported_extensions.push(extension.clone());
            }
        }
    }
    for extension in registry.supported_extensions.clone() {
        if !supported_extensions
            .iter()
            .any(|candidate| candidate == &extension)
        {
            supported_extensions.push(extension);
        }
    }
    registry.supported_extensions = supported_extensions;
    registry
}

impl FormatRegistry {
    pub fn new(codecs: Vec<Box<dyn FormatCodec>>) -> Self {
        let mut extension_map = indexmap::IndexMap::new();
        let mut supported_extensions = Vec::new();

        for (index, codec) in codecs.iter().enumerate() {
            for extension in codec.extensions() {
                if !supported_extensions
                    .iter()
                    .any(|candidate| candidate == extension)
                {
                    supported_extensions.push((*extension).to_owned());
                }
                extension_map.insert((*extension).to_owned(), index);
            }
        }

        Self {
            codecs,
            extension_map,
            supported_extensions,
            write_check: true,
        }
    }

    /// Turn the write check off or on. It is on by default.
    ///
    /// With the check on, [`Self::serialize`] decodes the output of every
    /// codec that [round-trips exactly](FormatCodec::round_trips_exactly)
    /// and refuses output that does not decode to the input. This costs one
    /// decode per write. Turn it off only when a caller already decodes and
    /// compares the exact bytes it writes.
    pub fn set_write_check(&mut self, enabled: bool) {
        self.write_check = enabled;
    }

    pub fn write_check(&self) -> bool {
        self.write_check
    }

    /// Register a codec. The last codec for each extension wins.
    pub fn register(&mut self, codec: Box<dyn FormatCodec>) {
        let index = self.codecs.len();
        for extension in codec.extensions() {
            if !self
                .supported_extensions
                .iter()
                .any(|value| value == extension)
            {
                self.supported_extensions.push((*extension).to_owned());
            }
            self.extension_map.insert((*extension).to_owned(), index);
        }
        self.codecs.push(codec);
    }

    pub fn with_builtins() -> Self {
        Self::new(vec![
            Box::new(codecs::json_codec()),
            Box::new(codecs::yaml_codec()),
            Box::new(codecs::toml_codec()),
            Box::new(codecs::json5_codec()),
            Box::new(codecs::jsonc_codec()),
            Box::new(codecs::jsonl_codec()),
            Box::new(codecs::hjson_codec()),
            Box::new(codecs::toon_codec()),
            Box::new(codecs::prose_codec(None, vec![])),
        ])
    }

    pub fn supported_extensions(&self) -> &[String] {
        &self.supported_extensions
    }

    pub fn serialize(
        &self,
        data: &Value,
        extension: &str,
        options: Option<FormatOptions>,
    ) -> Result<String, FormatRegistryError> {
        let codec = self.codec_for(extension)?;
        let encoded = codec.encode(data, options).map_err(|message| {
            FormatRegistryError::Serialization(SerializationError {
                format: codec.name().to_owned(),
                message: format!("Failed to serialize data to {}: {message}", codec.name()),
                cause: Some(Value::String(message)),
            })
        })?;
        if self.write_check && codec.round_trips_exactly() {
            check_round_trip(codec, data, &encoded)?;
        }
        Ok(encoded)
    }

    pub fn deserialize(
        &self,
        content: &str,
        extension: &str,
    ) -> Result<Value, FormatRegistryError> {
        let codec = self.codec_for(extension)?;
        codec.decode(content).map_err(|message| {
            FormatRegistryError::Serialization(SerializationError {
                format: codec.name().to_owned(),
                message: format!("Failed to deserialize {} data: {message}", codec.name()),
                cause: Some(Value::String(message)),
            })
        })
    }

    fn codec_for(&self, extension: &str) -> Result<&dyn FormatCodec, FormatRegistryError> {
        self.extension_map
            .get(extension)
            .and_then(|index| self.codecs.get(*index).map(|codec| codec.as_ref()))
            .ok_or_else(|| {
                let available = self
                    .supported_extensions
                    .iter()
                    .map(|ext| format!(".{ext}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                FormatRegistryError::UnsupportedFormat(UnsupportedFormatError {
                    format: extension.to_owned(),
                    message: if available.is_empty() {
                        format!("Unsupported format '.{extension}'. No formats registered.")
                    } else {
                        format!("Unsupported format '.{extension}'. Available formats: {available}")
                    },
                })
            })
    }
}

/// Reason in the `cause` of a [`SerializationError`] from the write check.
pub const ROUND_TRIP_MISMATCH: &str = "round-trip-mismatch";

/// Decode `encoded` and compare it with `data` (JS number semantics, key
/// order ignored). The error names the first differing location as a JSON
/// pointer. It never includes values, because they can be private.
fn check_round_trip(
    codec: &dyn FormatCodec,
    data: &Value,
    encoded: &str,
) -> Result<(), FormatRegistryError> {
    let refuse = |detail: String, pointer: Option<String>| {
        let mut cause = serde_json::Map::new();
        cause.insert("reason".into(), Value::from(ROUND_TRIP_MISMATCH));
        if let Some(pointer) = pointer {
            cause.insert("pointer".into(), Value::from(pointer));
        }
        cause.insert("detail".into(), Value::from(detail.clone()));
        FormatRegistryError::Serialization(SerializationError {
            format: codec.name().to_owned(),
            message: format!(
                "Refused to write {}: the encoded text does not decode to the data being written ({detail})",
                codec.name()
            ),
            cause: Some(Value::Object(cause)),
        })
    };
    let decoded = codec
        .decode(encoded)
        .map_err(|error| refuse(format!("decode failed: {error}"), None))?;
    match first_difference(data, &decoded, &mut String::new()) {
        None => Ok(()),
        Some(pointer) => Err(refuse(
            if pointer.is_empty() {
                "the root value differs".to_owned()
            } else {
                format!("first difference at '{pointer}'")
            },
            Some(pointer),
        )),
    }
}

/// JSON pointer of the first place where `left` and `right` differ.
fn first_difference(left: &Value, right: &Value, pointer: &mut String) -> Option<String> {
    let child = |pointer: &mut String, segment: &str, left: &Value, right: &Value| {
        let length = pointer.len();
        pointer.push('/');
        pointer.push_str(&segment.replace('~', "~0").replace('/', "~1"));
        let found = first_difference(left, right, pointer);
        pointer.truncate(length);
        found
    };
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            for (key, value) in left {
                let Some(other) = right.get(key) else {
                    return Some(format!(
                        "{pointer}/{}",
                        key.replace('~', "~0").replace('/', "~1")
                    ));
                };
                if let Some(found) = child(pointer, key, value, other) {
                    return Some(found);
                }
            }
            (left.len() != right.len()).then(|| pointer.clone())
        }
        (Value::Array(left), Value::Array(right)) => {
            for (index, (value, other)) in left.iter().zip(right).enumerate() {
                if let Some(found) = child(pointer, &index.to_string(), value, other) {
                    return Some(found);
                }
            }
            (left.len() != right.len()).then(|| pointer.clone())
        }
        _ => (!proseql_engine::validator::js_eq(left, right)).then(|| pointer.clone()),
    }
}

#[cfg(test)]
mod registration_tests {
    use super::*;

    struct TextCodec;
    impl FormatCodec for TextCodec {
        fn name(&self) -> &str {
            "text"
        }
        fn extensions(&self) -> &[&str] {
            &["txt", "json"]
        }
        fn encode(&self, data: &Value, _: Option<FormatOptions>) -> Result<String, String> {
            Ok(data.to_string())
        }
        fn decode(&self, raw: &str) -> Result<Value, String> {
            Ok(Value::String(raw.to_owned()))
        }
    }

    #[test]
    fn register_adds_extensions_and_overrides_without_duplicate_supported_extensions() {
        let mut registry = FormatRegistry::new(vec![Box::new(codecs::json_codec())]);
        assert_eq!(registry.supported_extensions(), &["json"]);
        registry.register(Box::new(TextCodec));
        assert_eq!(
            registry.deserialize("hello", "txt").unwrap(),
            Value::String("hello".into())
        );
        assert_eq!(
            registry.deserialize("hello", "json").unwrap(),
            Value::String("hello".into())
        );
        assert_eq!(registry.supported_extensions(), &["json", "txt"]);
        registry.register(Box::new(codecs::json_codec()));
        assert_eq!(
            registry.deserialize("123", "json").unwrap(),
            Value::from(123)
        );
        assert_eq!(registry.supported_extensions(), &["json", "txt"]);
    }
}
