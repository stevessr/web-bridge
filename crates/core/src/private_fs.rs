use std::{io, path::Path};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub(crate) fn restrict_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(crate) fn restrict_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn private_modes_replace_wider_permissions() {
        let root = std::env::temp_dir().join(format!("web-bridge-private-fs-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = root.join("secret");
        std::fs::write(&file, b"secret").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();

        restrict_dir(&root).unwrap();
        restrict_file(&file).unwrap();

        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}
