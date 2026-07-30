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
        }
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
        codec.encode(data, options).map_err(|message| {
            FormatRegistryError::Serialization(SerializationError {
                format: codec.name().to_owned(),
                message: format!("Failed to serialize data to {}: {message}", codec.name()),
                cause: Some(Value::String(message)),
            })
        })
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
