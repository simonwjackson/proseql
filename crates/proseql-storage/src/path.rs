pub fn get_file_extension(path: &str) -> String {
    let last_dot = path.rfind('.').map(|value| value as isize).unwrap_or(-1);
    let last_slash = path
        .rfind(['/', '\\'])
        .map(|value| value as isize)
        .unwrap_or(-1);
    if last_dot == -1 || last_dot <= last_slash {
        return String::new();
    }
    path[last_dot as usize + 1..].to_ascii_lowercase()
}

pub fn normalize_path(path: &str) -> String {
    let is_absolute = path.starts_with('/');
    let normalized_input = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized_input.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if let Some(previous) = parts.last() {
                if *previous != ".." {
                    parts.pop();
                } else if !is_absolute {
                    parts.push(part);
                }
            } else if !is_absolute {
                parts.push(part);
            }
            continue;
        }
        parts.push(part);
    }
    let normalized = parts.join("/");
    if is_absolute {
        if normalized.is_empty() {
            "/".to_owned()
        } else {
            format!("/{normalized}")
        }
    } else if normalized.is_empty() {
        ".".to_owned()
    } else {
        normalized
    }
}

pub fn join_path(root: &str, path: &str) -> String {
    if path.starts_with('/') {
        return normalize_path(path);
    }
    normalize_path(&format!("{}/{}", root.trim_end_matches('/'), path))
}

pub fn relative_to_root(root: &str, path: &str) -> String {
    let normalized_root = normalize_path(root).trim_end_matches('/').to_owned();
    let normalized_path = normalize_path(path);
    if normalized_path == normalized_root {
        return String::new();
    }
    let prefix = format!("{normalized_root}/");
    if normalized_path.starts_with(&prefix) {
        normalized_path[prefix.len()..].to_owned()
    } else {
        normalized_path
    }
}
