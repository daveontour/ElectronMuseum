package service

import "testing"

func TestNormalizeTagsForEmbedding(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"   ", ""},
		{"cat, dog", "cat, dog"},
		{"Dog, cat", "cat, dog"},
		{"a, A, a", "a"},
		{"  beach , Beach , sun ", "beach, sun"},
	}
	for _, tt := range tests {
		got := NormalizeTagsForEmbedding(tt.in)
		if got != tt.want {
			t.Errorf("NormalizeTagsForEmbedding(%q) = %q; want %q", tt.in, got, tt.want)
		}
	}
}

func TestTagEmbeddingSignature(t *testing.T) {
	a := TagEmbeddingSignature("cat, dog")
	b := TagEmbeddingSignature("cat, dog")
	if len(a) != 64 {
		t.Fatalf("TagEmbeddingSignature length = %d; want 64 hex chars", len(a))
	}
	if a != b {
		t.Fatalf("TagEmbeddingSignature not stable: %q vs %q", a, b)
	}
	if TagEmbeddingSignature("cat") == a {
		t.Fatal("TagEmbeddingSignature should differ for different normalized strings")
	}
}
