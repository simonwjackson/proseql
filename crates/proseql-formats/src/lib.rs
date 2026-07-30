pub mod codecs;
pub mod prose;

pub use proseql_engine::errors::{SerializationError, UnsupportedFormatError};
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

impl FormatRegistry {
    pub fn new(codecs: Vec<Box<dyn FormatCodec>>) -> Self {
        let mut extension_map = indexmap::IndexMap::new();
        let mut supported_extensions = Vec::new();

        for (index, codec) in codecs.iter().enumerate() {
            for extension in codec.extensions() {
                if !extension_map.contains_key(*extension) {
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
