package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"cloud.google.com/go/pubsub"
	"github.com/google/uuid"
)

// Version info
const version = "1.2.0"

// ANSI color codes for terminal output
const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorBlue   = "\033[34m"
	colorPurple = "\033[35m"
	colorCyan   = "\033[36m"
	colorGray   = "\033[90m"
	colorBold   = "\033[1m"
)

// Config holds all configuration options
type Config struct {
	ProjectID      string
	SubscriptionID string
	TopicProjectID string
	TopicID        string
	OutputFile     string
	MaxMessages    int64
	Duration       time.Duration
	Verbose        bool
	Quiet          bool
	NoColor        bool
	PrettyPrint    bool
	ShowStats      bool
	StatsInterval  time.Duration
	ExcludeFields  string
	DryRun         bool
	AckDeadline    time.Duration
	AckMode        string // "ack", "nack", or "none"
	Purge          bool   // Seek subscription to now, clearing all pending messages
	Filter         string // Pub/Sub filter expression for temp subscriptions
}

// Stats tracks message statistics
type Stats struct {
	MessagesReceived   int64
	MessagesProcessed  int64
	BytesReceived      int64
	CompressedMessages int64
	Errors             int64
	StartTime          time.Time
}

var (
	config          Config
	stats           Stats
	fieldsToExclude map[string]struct{}
	outputWriter    *OutputWriter
)

// OutputWriter handles buffered file writing with thread safety
type OutputWriter struct {
	file   *os.File
	writer *bufio.Writer
	mu     sync.Mutex
}

func NewOutputWriter(path string) (*OutputWriter, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &OutputWriter{
		file:   f,
		writer: bufio.NewWriterSize(f, 64*1024), // 64KB buffer
	}, nil
}

func (w *OutputWriter) WriteLine(line string) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	trimmed := strings.ReplaceAll(line, "\n", " ")
	_, err := w.writer.WriteString(trimmed + "\n")
	return err
}

func (w *OutputWriter) Flush() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.writer.Flush()
}

func (w *OutputWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.writer.Flush(); err != nil {
		return err
	}
	return w.file.Close()
}

func init() {
	// Command line flags with environment variable fallbacks
	flag.StringVar(&config.ProjectID, "project", getDefaultProjectID(""),
		"GCP Project ID (auto-detected from env/metadata, env: PUBSUB_PROJECT_ID)")
	flag.StringVar(&config.SubscriptionID, "subscription", envOrDefault("PUBSUB_SUBSCRIPTION_ID", ""),
		"Subscription ID (env: PUBSUB_SUBSCRIPTION_ID)")
	flag.StringVar(&config.TopicProjectID, "topic-project", getDefaultProjectID(""),
		"Topic Project ID for temp subscriptions (auto-detected, env: PUBSUB_TOPIC_PROJECT_ID)")
	flag.StringVar(&config.TopicID, "topic", envOrDefault("PUBSUB_TOPIC_ID", ""),
		"Topic ID for temp subscriptions (env: PUBSUB_TOPIC_ID)")
	flag.StringVar(&config.OutputFile, "output", envOrDefault("PUBSUB_OUTPUT_FILE", "messages.txt"),
		"Output file path (env: PUBSUB_OUTPUT_FILE)")
	flag.Int64Var(&config.MaxMessages, "max-messages", 0,
		"Maximum number of messages to receive (0 = unlimited)")
	flag.DurationVar(&config.Duration, "duration", 0,
		"Maximum duration to run (e.g., 5m, 1h) (0 = unlimited)")
	flag.BoolVar(&config.Verbose, "verbose", false,
		"Enable verbose output")
	flag.BoolVar(&config.Quiet, "quiet", false,
		"Suppress non-essential output")
	flag.BoolVar(&config.NoColor, "no-color", false,
		"Disable colored output")
	flag.BoolVar(&config.PrettyPrint, "pretty", true,
		"Pretty print JSON messages")
	flag.BoolVar(&config.ShowStats, "stats", true,
		"Show periodic statistics")
	flag.DurationVar(&config.StatsInterval, "stats-interval", 10*time.Second,
		"Statistics display interval")
	flag.StringVar(&config.ExcludeFields, "exclude-fields", "content,activeContent,historyFull,historyDelta,cfLrecs",
		"Comma-separated list of JSON fields to exclude from output")
	flag.BoolVar(&config.DryRun, "dry-run", false,
		"Connect and receive but don't save to file")
	flag.DurationVar(&config.AckDeadline, "ack-deadline", 30*time.Second,
		"Acknowledgement deadline for messages")
	flag.StringVar(&config.AckMode, "ack-mode", "ack",
		"Message acknowledgment mode: 'ack' (acknowledge), 'nack' (negative ack - redelivery), 'none' (no ack - message stays pending)")
	flag.BoolVar(&config.Purge, "purge", false,
		"Purge all pending messages from the subscription (seeks to current time)")
	flag.StringVar(&config.Filter, "filter", "",
		"Pub/Sub filter expression for temp subscriptions (e.g., 'attributes.type=\"order\"')")

	// Custom usage message
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "%s%sPub/Sub Message Listener v%s%s\n\n", colorBold, colorCyan, version, colorReset)
		fmt.Fprintf(os.Stderr, "%sUsage:%s %s [options]\n\n", colorBold, colorReset, os.Args[0])
		fmt.Fprintf(os.Stderr, "%sOptions:%s\n", colorBold, colorReset)
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\n%sExamples:%s\n", colorBold, colorReset)
		fmt.Fprintf(os.Stderr, "  %s -max-messages 100 -output data.txt\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s -duration 5m -verbose\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s -subscription my-sub -quiet -no-color\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s -purge  # Clear all pending messages\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s -topic my-topic -filter 'attributes.type=\"order\"'  # Filter messages\n", os.Args[0])
	}
}

func main() {
	flag.Parse()

	// Parse exclude fields
	fieldsToExclude = make(map[string]struct{})
	for _, f := range strings.Split(config.ExcludeFields, ",") {
		if f = strings.TrimSpace(f); f != "" {
			fieldsToExclude[f] = struct{}{}
		}
	}

	// Disable colors if requested or if not a terminal
	if config.NoColor {
		disableColors()
	}

	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	// Show startup banner
	if !config.Quiet && !config.Purge {
		printBanner()
	}

	// Handle purge mode
	if config.Purge {
		if err := purgeSubscription(); err != nil {
			logError("Purge failed: %v", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	// Initialize output writer (unless dry-run)
	if !config.DryRun {
		var err error
		outputWriter, err = NewOutputWriter(config.OutputFile)
		if err != nil {
			logError("Failed to open output file: %v", err)
			os.Exit(1)
		}
		defer func() {
			if err := outputWriter.Close(); err != nil {
				logError("Failed to close output file: %v", err)
			}
		}()
	}

	ctx := context.Background()
	client, err := pubsub.NewClient(ctx, config.ProjectID)
	if err != nil {
		logError("Failed to create subscriber client: %v", err)
		os.Exit(1)
	}
	defer client.Close()

	sub, cleanup, err := prepareSubscription(ctx, client)
	if err != nil {
		logError("Failed to prepare subscription: %v", err)
		os.Exit(1)
	}
	if cleanup != nil {
		defer cleanup()
	}

	ctx, cancel := context.WithCancel(ctx)

	// Apply duration limit if specified
	if config.Duration > 0 {
		ctx, cancel = context.WithTimeout(ctx, config.Duration)
		logInfo("Will run for %v", config.Duration)
	}

	var wg sync.WaitGroup
	stats.StartTime = time.Now()

	// Start stats printer if enabled
	if config.ShowStats && !config.Quiet {
		wg.Add(1)
		go func() {
			defer wg.Done()
			printStatsPeriodically(ctx)
		}()
	}

	// Start message receiver
	wg.Add(1)
	go func() {
		defer wg.Done()
		sub.ReceiveSettings.MaxOutstandingMessages = 100
		err := sub.Receive(ctx, func(ctx context.Context, m *pubsub.Message) {
			// Check if we've reached max messages
			if config.MaxMessages > 0 && atomic.LoadInt64(&stats.MessagesReceived) >= config.MaxMessages {
				m.Nack()
				cancel()
				return
			}

			atomic.AddInt64(&stats.MessagesReceived, 1)
			atomic.AddInt64(&stats.BytesReceived, int64(len(m.Data)))

			handleMessage(m)

			atomic.AddInt64(&stats.MessagesProcessed, 1)
		})
		if err != nil && ctx.Err() == nil {
			logError("Receive error: %v", err)
			cancel()
		}
	}()

	logSuccess("Listening for messages on %s", sub.String())
	if config.MaxMessages > 0 {
		logInfo("Will stop after %d messages", config.MaxMessages)
	}
	if config.DryRun {
		logWarning("DRY RUN mode - messages will not be saved to file")
	}
	if strings.ToLower(config.AckMode) == "nack" {
		logWarning("NACK mode - messages will be redelivered immediately")
	} else if strings.ToLower(config.AckMode) == "none" {
		logWarning("NO-ACK mode - messages will be redelivered after ack deadline (%v)", config.AckDeadline)
	}

	// Handle Ctrl+C / SIGTERM
	sigC := make(chan os.Signal, 1)
	signal.Notify(sigC, os.Interrupt, syscall.SIGTERM)

	select {
	case <-sigC:
		logWarning("Shutdown signal received. Closing subscriber...")
	case <-ctx.Done():
		if config.MaxMessages > 0 && atomic.LoadInt64(&stats.MessagesReceived) >= config.MaxMessages {
			logSuccess("Reached maximum message count (%d)", config.MaxMessages)
		} else if config.Duration > 0 {
			logSuccess("Duration limit reached")
		}
	}

	cancel()
	wg.Wait()

	// Flush output file before printing stats
	if outputWriter != nil {
		if err := outputWriter.Flush(); err != nil {
			logError("Failed to flush output file: %v", err)
		}
	}

	// Print final stats
	if !config.Quiet {
		printFinalStats()
	}

	logSuccess("Subscriber stopped.")
}

func purgeSubscription() error {
	if config.SubscriptionID == "" {
		return fmt.Errorf("subscription ID is required for purge operation")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := pubsub.NewClient(ctx, config.ProjectID)
	if err != nil {
		return fmt.Errorf("create client: %w", err)
	}
	defer client.Close()

	sub := client.Subscription(config.SubscriptionID)

	// Check if subscription exists
	exists, err := sub.Exists(ctx)
	if err != nil {
		return fmt.Errorf("check subscription: %w", err)
	}
	if !exists {
		return fmt.Errorf("subscription %q does not exist in project %q", config.SubscriptionID, config.ProjectID)
	}

	logInfo("Purging messages from subscription: %s", config.SubscriptionID)

	// Seek to current time - this effectively skips all pending messages
	seekTime := time.Now()
	if err := sub.SeekToTime(ctx, seekTime); err != nil {
		return fmt.Errorf("seek to time: %w", err)
	}

	logSuccess("Successfully purged subscription %s", config.SubscriptionID)
	logInfo("All messages published before %s have been skipped", seekTime.Format(time.RFC3339))

	return nil
}

func prepareSubscription(ctx context.Context, client *pubsub.Client) (*pubsub.Subscription, func(), error) {
	if config.SubscriptionID != "" {
		sub := client.Subscription(config.SubscriptionID)
		sub.ReceiveSettings.MaxExtension = config.AckDeadline
		return sub, nil, nil
	}

	if config.TopicID == "" {
		return nil, nil, fmt.Errorf("no subscription provided and topic_id is empty; cannot create temp subscription")
	}

	tempID := fmt.Sprintf("temp-sub-%s", uuid.NewString()[:8])
	topic := client.TopicInProject(config.TopicID, config.TopicProjectID)

	cfg := pubsub.SubscriptionConfig{
		Topic:            topic,
		AckDeadline:      config.AckDeadline,
		ExpirationPolicy: 24 * time.Hour,
		Filter:           config.Filter,
	}

	if config.Filter != "" {
		logInfo("Using filter: %s", config.Filter)
	}

	sub, err := client.CreateSubscription(ctx, tempID, cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("create temp subscription: %w", err)
	}

	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := sub.Delete(ctx); err != nil {
			logError("Delete temp subscription %s: %v", tempID, err)
		} else {
			logInfo("Deleted temp subscription %s", tempID)
		}
	}

	logSuccess("Created temporary subscription: %s", sub.String())
	return sub, cleanup, nil
}

func handleMessage(m *pubsub.Message) {
	isCompressed := m.Attributes["simple-message-converter-compressed"] == "true"
	if isCompressed {
		atomic.AddInt64(&stats.CompressedMessages, 1)
		if err := processCompressed(m); err != nil {
			atomic.AddInt64(&stats.Errors, 1)
			logError("Decompress error: %v", err)
		}
	} else {
		if config.Verbose {
			logVerbose("Message: %d bytes, attrs: %v", len(m.Data), m.Attributes)
		}
		if !config.DryRun {
			writeMessageWithAttributes(m.Attributes, string(m.Data))
		}
	}

	// Handle acknowledgment based on mode
	ackMessage(m)
}

func ackMessage(m *pubsub.Message) {
	switch strings.ToLower(config.AckMode) {
	case "ack":
		m.Ack()
	case "nack":
		m.Nack()
	case "none":
		// Do nothing - message will be redelivered after ack deadline
		if config.Verbose {
			logVerbose("Message not acknowledged (will be redelivered)")
		}
	default:
		m.Ack() // Default to ack
	}
}

func processCompressed(m *pubsub.Message) error {
	zr, err := gzip.NewReader(strings.NewReader(string(m.Data)))
	if err != nil {
		return fmt.Errorf("open gzip: %w", err)
	}
	defer zr.Close()

	decompressed, err := io.ReadAll(zr)
	if err != nil {
		return fmt.Errorf("read gzip: %w", err)
	}

	// Try JSON decode and filter
	var obj map[string]interface{}
	if err := json.Unmarshal(decompressed, &obj); err == nil {
		filtered := make(map[string]interface{}, len(obj))
		for k, v := range obj {
			if _, skip := fieldsToExclude[k]; skip {
				continue
			}
			filtered[k] = v
		}

		if config.Verbose {
			var output []byte
			if config.PrettyPrint {
				output, _ = json.MarshalIndent(filtered, "", "  ")
			} else {
				output, _ = json.Marshal(filtered)
			}
			logVerbose("JSON message: %d bytes (compressed: %d), attrs: %v", len(decompressed), len(m.Data), m.Attributes)
			fmt.Println(string(output))
		}

		if !config.DryRun {
			writeMessageWithAttributes(m.Attributes, string(decompressed))
		}
		return nil
	}

	// Non-JSON payloads
	if config.Verbose {
		logVerbose("Non-JSON decompressed data (%d bytes) %v", len(decompressed), m.Attributes)
	}
	if !config.DryRun {
		writeMessageWithAttributes(m.Attributes, string(decompressed))
	}
	return nil
}

func appendLine(path, line string) {
	if outputWriter == nil {
		return
	}
	if err := outputWriter.WriteLine(line); err != nil {
		logError("Write output file: %v", err)
		atomic.AddInt64(&stats.Errors, 1)
	}
}

// writeMessageWithAttributes writes attributes as JSON on one line, then message data on the next line
func writeMessageWithAttributes(attrs map[string]string, data string) {
	if outputWriter == nil {
		return
	}

	// Write attributes as JSON
	attrsJSON, err := json.Marshal(attrs)
	if err != nil {
		attrsJSON = []byte(fmt.Sprintf("{\"error\": \"failed to marshal attributes: %v\"}", err))
	}
	appendLine(config.OutputFile, "ATTRS: "+string(attrsJSON))

	// Write message data
	appendLine(config.OutputFile, data)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// getDefaultProjectID attempts to detect the GCP project ID from:
// 1. Environment variable (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT)
// 2. GCP VM metadata server (if running on GCP)
// 3. Falls back to provided default
func getDefaultProjectID(fallback string) string {
	// Check environment variables
	for _, envVar := range []string{"PUBSUB_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GCP_PROJECT"} {
		if v := os.Getenv(envVar); v != "" {
			return v
		}
	}

	// Try GCP metadata server (works on GCE, GKE, Cloud Run, etc.)
	if projectID := getProjectFromMetadata(); projectID != "" {
		return projectID
	}

	return fallback
}

// getProjectFromMetadata fetches project ID from GCP metadata server
func getProjectFromMetadata() string {
	client := &http.Client{Timeout: 2 * time.Second}

	req, err := http.NewRequest("GET", "http://metadata.google.internal/computeMetadata/v1/project/project-id", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Metadata-Flavor", "Google")

	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return ""
	}

	return strings.TrimSpace(string(body))
}

// ============================================================================
// UI / Logging Functions
// ============================================================================

func disableColors() {
	// Empty strings effectively disable colors
}

func printBanner() {
	fmt.Println()
	fmt.Printf("%s%s╔══════════════════════════════════════════════════════════╗%s\n", colorBold, colorCyan, colorReset)
	fmt.Printf("%s%s║         Pub/Sub Message Listener v%-23s║%s\n", colorBold, colorCyan, version, colorReset)
	fmt.Printf("%s%s╚══════════════════════════════════════════════════════════╝%s\n\n", colorBold, colorCyan, colorReset)

	fmt.Printf("%sConfiguration:%s\n", colorBold, colorReset)
	fmt.Printf("  %-20s %s%s%s\n", "Project:", colorYellow, config.ProjectID, colorReset)
	fmt.Printf("  %-20s %s%s%s\n", "Subscription:", colorYellow, config.SubscriptionID, colorReset)
	fmt.Printf("  %-20s %s%s%s\n", "Topic Project:", colorYellow, config.TopicProjectID, colorReset)
	fmt.Printf("  %-20s %s%s%s\n", "Topic:", colorYellow, config.TopicID, colorReset)
	fmt.Printf("  %-20s %s%s%s\n", "Output File:", colorYellow, config.OutputFile, colorReset)
	if config.MaxMessages > 0 {
		fmt.Printf("  %-20s %s%d%s\n", "Max Messages:", colorYellow, config.MaxMessages, colorReset)
	}
	if config.Duration > 0 {
		fmt.Printf("  %-20s %s%v%s\n", "Duration:", colorYellow, config.Duration, colorReset)
	}
	fmt.Println()
}

func printStatsPeriodically(ctx context.Context) {
	ticker := time.NewTicker(config.StatsInterval)
	defer ticker.Stop()

	spinChars := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	spinIdx := 0

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			received := atomic.LoadInt64(&stats.MessagesReceived)
			bytes := atomic.LoadInt64(&stats.BytesReceived)
			compressed := atomic.LoadInt64(&stats.CompressedMessages)
			errors := atomic.LoadInt64(&stats.Errors)
			elapsed := time.Since(stats.StartTime).Round(time.Second)

			rate := float64(0)
			if elapsed.Seconds() > 0 {
				rate = float64(received) / elapsed.Seconds()
			}

			// Progress indicator
			spin := spinChars[spinIdx%len(spinChars)]
			spinIdx++

			fmt.Printf("\r%s%s %s[Stats]%s Msgs: %s%d%s | Rate: %s%.1f/s%s | Bytes: %s%s%s | Compressed: %s%d%s | Errors: %s%d%s | Elapsed: %s%v%s    ",
				colorCyan, spin, colorBold, colorReset,
				colorGreen, received, colorReset,
				colorBlue, rate, colorReset,
				colorPurple, formatBytes(bytes), colorReset,
				colorYellow, compressed, colorReset,
				colorRed, errors, colorReset,
				colorGray, elapsed, colorReset,
			)

			// Show progress toward max messages if set
			if config.MaxMessages > 0 {
				pct := float64(received) / float64(config.MaxMessages) * 100
				fmt.Printf("| Progress: %s%.1f%%%s", colorCyan, pct, colorReset)
			}
		}
	}
}

func printFinalStats() {
	fmt.Println() // Clear the progress line
	fmt.Printf("%s%s╔══════════════════════════════════════════════════════════╗%s\n", colorBold, colorPurple, colorReset)
	fmt.Printf("%s%s║                       Final Statistics                   ║%s\n", colorBold, colorPurple, colorReset)
	fmt.Printf("%s%s╚══════════════════════════════════════════════════════════╝%s\n\n", colorBold, colorPurple, colorReset)

	elapsed := time.Since(stats.StartTime).Round(time.Millisecond)
	received := atomic.LoadInt64(&stats.MessagesReceived)
	processed := atomic.LoadInt64(&stats.MessagesProcessed)
	bytes := atomic.LoadInt64(&stats.BytesReceived)
	compressed := atomic.LoadInt64(&stats.CompressedMessages)
	errors := atomic.LoadInt64(&stats.Errors)

	rate := float64(0)
	if elapsed.Seconds() > 0 {
		rate = float64(received) / elapsed.Seconds()
	}

	fmt.Printf("  %s%-25s%s %s%d%s\n", colorBold, "Messages Received:", colorReset, colorGreen, received, colorReset)
	fmt.Printf("  %s%-25s%s %s%d%s\n", colorBold, "Messages Processed:", colorReset, colorGreen, processed, colorReset)
	fmt.Printf("  %s%-25s%s %s%s%s\n", colorBold, "Total Bytes:", colorReset, colorPurple, formatBytes(bytes), colorReset)
	fmt.Printf("  %s%-25s%s %s%d%s\n", colorBold, "Compressed Messages:", colorReset, colorYellow, compressed, colorReset)
	fmt.Printf("  %s%-25s%s %s%d%s\n", colorBold, "Errors:", colorReset, colorRed, errors, colorReset)
	fmt.Printf("  %s%-25s%s %s%.2f msg/sec%s\n", colorBold, "Average Rate:", colorReset, colorBlue, rate, colorReset)
	fmt.Printf("  %s%-25s%s %s%v%s\n", colorBold, "Total Duration:", colorReset, colorGray, elapsed, colorReset)
	fmt.Printf("  %s%-25s%s %s%s%s\n", colorBold, "Output File:", colorReset, colorCyan, config.OutputFile, colorReset)
	fmt.Println()
}

func formatBytes(bytes int64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
	)

	switch {
	case bytes >= GB:
		return fmt.Sprintf("%.2f GB", float64(bytes)/float64(GB))
	case bytes >= MB:
		return fmt.Sprintf("%.2f MB", float64(bytes)/float64(MB))
	case bytes >= KB:
		return fmt.Sprintf("%.2f KB", float64(bytes)/float64(KB))
	default:
		return fmt.Sprintf("%d B", bytes)
	}
}

func logInfo(format string, args ...interface{}) {
	if config.Quiet {
		return
	}
	msg := fmt.Sprintf(format, args...)
	fmt.Printf("%s[INFO]%s %s\n", colorBlue, colorReset, msg)
}

func logSuccess(format string, args ...interface{}) {
	if config.Quiet {
		return
	}
	msg := fmt.Sprintf(format, args...)
	fmt.Printf("%s[✓]%s %s\n", colorGreen, colorReset, msg)
}

func logWarning(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Printf("%s[⚠]%s %s\n", colorYellow, colorReset, msg)
}

func logError(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Printf("%s[✗]%s %s\n", colorRed, colorReset, msg)
}

func logVerbose(format string, args ...interface{}) {
	if !config.Verbose {
		return
	}
	msg := fmt.Sprintf(format, args...)
	fmt.Printf("%s[DEBUG]%s %s\n", colorGray, colorReset, msg)
}
