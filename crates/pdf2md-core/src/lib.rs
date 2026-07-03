pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PdfVersion {
    pub major: u8,
    pub minor: u8,
}

impl PdfVersion {
    pub const fn new(major: u8, minor: u8) -> Self {
        Self { major, minor }
    }
}

pub fn parse_pdf_version(input: &[u8]) -> Option<PdfVersion> {
    let header = input.strip_prefix(b"%PDF-")?;
    if header.len() < 3 || header[1] != b'.' {
        return None;
    }
    let major = parse_ascii_digit(header[0])?;
    let minor = parse_ascii_digit(header[2])?;
    Some(PdfVersion::new(major, minor))
}

pub fn has_pdf_header(input: &[u8]) -> bool {
    parse_pdf_version(input).is_some()
}

#[no_mangle]
pub extern "C" fn pdf2md_core_version_major() -> u32 {
    parse_version_component(env!("CARGO_PKG_VERSION_MAJOR"))
}

#[no_mangle]
pub extern "C" fn pdf2md_core_version_minor() -> u32 {
    parse_version_component(env!("CARGO_PKG_VERSION_MINOR"))
}

#[no_mangle]
pub extern "C" fn pdf2md_core_version_patch() -> u32 {
    parse_version_component(env!("CARGO_PKG_VERSION_PATCH"))
}

#[no_mangle]
pub extern "C" fn pdf2md_alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn pdf2md_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: Callers pass pointers returned by `pdf2md_alloc` with the same
    // capacity. The logical length remains zero because JS writes into the
    // allocation before calling exported read-only functions.
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

#[no_mangle]
pub unsafe extern "C" fn pdf2md_has_pdf_header(ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    // SAFETY: The JS bridge passes a live allocation and byte length created by
    // `pdf2md_alloc`, then deallocates only after this function returns.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    u32::from(has_pdf_header(bytes))
}

fn parse_ascii_digit(value: u8) -> Option<u8> {
    value.is_ascii_digit().then_some(value - b'0')
}

fn parse_version_component(value: &str) -> u32 {
    value.parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pdf_header_version() {
        assert_eq!(
            parse_pdf_version(b"%PDF-1.7\n%\xFF\xFF\xFF\xFF"),
            Some(PdfVersion::new(1, 7))
        );
    }

    #[test]
    fn rejects_missing_or_malformed_headers() {
        assert_eq!(parse_pdf_version(b""), None);
        assert_eq!(parse_pdf_version(b"not a pdf"), None);
        assert_eq!(parse_pdf_version(b"%PDF-1"), None);
        assert_eq!(parse_pdf_version(b"%PDF-a.b"), None);
    }

    #[test]
    fn exposes_header_predicate() {
        assert!(has_pdf_header(b"%PDF-2.0\n"));
        assert!(!has_pdf_header(b"%!PS-Adobe-3.0\n"));
    }

    #[test]
    fn exposes_wasm_bridge_version() {
        assert_eq!(
            pdf2md_core_version_major(),
            env!("CARGO_PKG_VERSION_MAJOR").parse::<u32>().unwrap()
        );
        assert_eq!(
            pdf2md_core_version_minor(),
            env!("CARGO_PKG_VERSION_MINOR").parse::<u32>().unwrap()
        );
        assert_eq!(
            pdf2md_core_version_patch(),
            env!("CARGO_PKG_VERSION_PATCH").parse::<u32>().unwrap()
        );
    }

    #[test]
    fn wasm_bridge_checks_headers_from_allocated_memory() {
        let bytes = b"%PDF-1.4\n";
        let ptr = pdf2md_alloc(bytes.len());
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            assert_eq!(pdf2md_has_pdf_header(ptr, bytes.len()), 1);
            pdf2md_dealloc(ptr, bytes.len());
        }
    }
}
