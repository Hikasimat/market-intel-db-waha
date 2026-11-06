package config

import (
	"os"
	"strconv"
	"strings"
)

// Config represents all engine runtime configurations.
type Config struct {
	AppEnv              string
	ServerPort          string
	ListenAddr          string
	DatabasePath        string
	StaticDir           string
	LogLevel            string
	AuthMode            string
	DefaultProvider     string
	APIKey              string
	EncryptionKey       string
	MaxCallsPerSession  int
	WebRTCStunServers   []string
	WebRTCTurnServers   []string
	WAHABaseURL         string
	WAHAAPIKey          string
	WAHASessionName     string
}

// LoadFromEnv loads configuration values from environment variables with sensible defaults.
func LoadFromEnv() Config {
	port := getEnv("SERVER_PORT", "3001")
	addr := getEnv("SERVER_ADDR", ":"+port)
	if !strings.HasPrefix(addr, ":") && !strings.Contains(addr, ":") {
		addr = ":" + addr
	}

	maxCalls, _ := strconv.Atoi(getEnv("MAX_CALLS_PER_SESSION", "8"))

	stunRaw := getEnv("WEBRTC_STUN_SERVERS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
	var stuns []string
	for _, s := range strings.Split(stunRaw, ",") {
		s = strings.TrimSpace(s)
		if s != "" {
			stuns = append(stuns, s)
		}
	}

	turnRaw := getEnv("WEBRTC_TURN_SERVERS", "")
	var turns []string
	for _, t := range strings.Split(turnRaw, ",") {
		t = strings.TrimSpace(t)
		if t != "" {
			turns = append(turns, t)
		}
	}

	return Config{
		AppEnv:             getEnv("APP_ENV", "production"),
		ServerPort:         port,
		ListenAddr:         addr,
		DatabasePath:       getEnv("DATABASE_URL", "wacalls.db"),
		StaticDir:          getEnv("STATIC_DIR", "client/dist"),
		LogLevel:           getEnv("LOG_LEVEL", "info"),
		AuthMode:           getEnv("WACALLS_AUTH_MODE", "native"),
		DefaultProvider:    getEnv("WACALLS_DEFAULT_PROVIDER", "native"),
		APIKey:             getEnv("WACALLS_INTERNAL_TOKEN", getEnv("WACALLS_TOKEN", getEnv("WACALLS_API_KEY", ""))),
		EncryptionKey:      getEnv("WACALLS_ENCRYPTION_KEY", ""),
		MaxCallsPerSession: maxCalls,
		WebRTCStunServers:  stuns,
		WebRTCTurnServers:  turns,
		WAHABaseURL:        getEnv("WAHA_BASE_URL", "http://localhost:3000"),
		WAHAAPIKey:         getEnv("WAHA_API_KEY", ""),
		WAHASessionName:    getEnv("WAHA_SESSION_NAME", "default"),
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return strings.TrimSpace(val)
	}
	return fallback
}

