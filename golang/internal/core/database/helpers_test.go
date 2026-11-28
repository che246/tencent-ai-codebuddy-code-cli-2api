package database

import "os"

func writeFile(p, content string) error { return os.WriteFile(p, []byte(content), 0o644) }
