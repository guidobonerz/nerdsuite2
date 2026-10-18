package kickass

// js.go - the JavaScript the Node server read the requests with: String(v), Number(v), what is
// true, trim(), the \s of its regular expressions and Buffer.from(s, 'base64'). The browser's JSON
// gives the same answers here as it did there.

import (
	"errors"
	"io/fs"
	"math"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// undefined: a field the JSON does not have (null is nil)
type undefined struct{}

// field: a field of a JSON object - undefined when it is none or the value is no object
func field(v any, key string) any {
	if m, ok := v.(map[string]any); ok {
		if x, ok := m[key]; ok {
			return x
		}
	}
	return undefined{}
}

// jsWS: the white space of JavaScript (its \s and trim()), not only the ASCII of Go's \s
const jsWS = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// jsDot: the . of JavaScript - anything but the line terminators
const jsDot = `[^\n\r\x{2028}\x{2029}]`

// jsRe: a regular expression of JavaScript - its [\s\S], \s and \S as JavaScript has them
func jsRe(re string) *regexp.Regexp {
	re = strings.ReplaceAll(re, `[\s\S]`, `(?s:.)`)
	re = strings.ReplaceAll(re, `\S`, `[^`+jsWS+`]`)
	re = strings.ReplaceAll(re, `\s`, `[`+jsWS+`]`)
	return regexp.MustCompile(re)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsTrim: String.prototype.trim
func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// jsString: String(v)
func jsString(v any) string {
	switch x := v.(type) {
	case undefined:
		return "undefined"
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return numString(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// numString: a number as JavaScript writes it (1e+21, 1e-7)
func numString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	if a := math.Abs(f); a != 0 && (a >= 1e21 || a < 1e-6) {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		s = strings.Replace(s, "e+0", "e+", 1)
		return strings.Replace(s, "e-0", "e-", 1)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// jsTruthy: what an if of JavaScript takes as true
func jsTruthy(v any) bool {
	switch x := v.(type) {
	case undefined, nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

var (
	decimalRe = regexp.MustCompile(`^[+-]?(Infinity|(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?)$`)
	radixRe   = regexp.MustCompile(`^0([xXoObB])([0-9a-fA-F]+)$`)
)

// jsNumber: Number(v) - NaN for what is no number
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case undefined:
		return math.NaN()
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return numberOf(x)
	case []any:
		return numberOf(jsString(x))
	}
	return math.NaN()
}

// numberOf: Number of a text - ” is 0, 0x10 is 16
func numberOf(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	if decimalRe.MatchString(s) {
		f, _ := strconv.ParseFloat(s, 64) // too large: Infinity, as in JavaScript
		return f
	}
	if m := radixRe.FindStringSubmatch(s); m != nil {
		base := map[byte]float64{'x': 16, 'o': 8, 'b': 2}[m[1][0]|0x20]
		f := 0.0
		for _, c := range strings.ToLower(m[2]) {
			d := float64(strings.IndexRune("0123456789abcdef", c))
			if d >= base {
				return math.NaN()
			}
			f = f*base + d
		}
		return f
	}
	return math.NaN()
}

// parseHex: parseInt(s, 16) of hex digits
func parseHex(s string) float64 {
	if n, err := strconv.ParseUint(s, 16, 64); err == nil {
		return float64(n)
	}
	f := 0.0
	for _, c := range strings.ToLower(s) {
		f = f*16 + float64(strings.IndexRune("0123456789abcdef", c))
	}
	return f
}

// jsNum: a number for the JSON - null for NaN (JSON.stringify writes it so)
func jsNum(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}

// decodeBase64: Buffer.from(s, 'base64') - it skips what is no base64 (the url alphabet is base64
// too) and stops at the first '='
func decodeBase64(s string) []byte {
	out := make([]byte, 0, len(s)*3/4)
	var acc uint32
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		var d byte
		switch {
		case c >= 'A' && c <= 'Z':
			d = c - 'A'
		case c >= 'a' && c <= 'z':
			d = c - 'a' + 26
		case c >= '0' && c <= '9':
			d = c - '0' + 52
		case c == '+' || c == '-':
			d = 62
		case c == '/' || c == '_':
			d = 63
		case c == '=':
			i = len(s)
			continue
		default:
			continue
		}
		acc = acc<<6 | uint32(d)
		n++
		if n == 4 {
			out = append(out, byte(acc>>16), byte(acc>>8), byte(acc))
			acc, n = 0, 0
		}
	}
	switch n {
	case 2:
		out = append(out, byte(acc>>4))
	case 3:
		out = append(out, byte(acc>>10), byte(acc>>2))
	}
	return out
}

// startError: the message of a program that did not start, as Node gives it for one that is not
// there ("spawn x ENOENT", also for a folder that is not there); Go's own text for the others
func startError(cmd string, err error) string {
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return "spawn " + cmd + " ENOENT"
	}
	return err.Error()
}
