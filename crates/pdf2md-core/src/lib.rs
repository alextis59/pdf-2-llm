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

fn parse_ascii_digit(value: u8) -> Option<u8> {
    value.is_ascii_digit().then_some(value - b'0')
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
}
