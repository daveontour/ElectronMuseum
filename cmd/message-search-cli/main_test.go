package main

import (
	"reflect"
	"testing"
)

func TestParseIntIDsJSON(t *testing.T) {
	ids, err := parseIntIDsJSON(`[10,11,12]`)
	if err != nil {
		t.Fatalf("parseIntIDsJSON returned error: %v", err)
	}
	want := []int64{10, 11, 12}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("unexpected ids: got=%v want=%v", ids, want)
	}
}

func TestParseIntIDsJSON_Empty(t *testing.T) {
	ids, err := parseIntIDsJSON("")
	if err != nil {
		t.Fatalf("parseIntIDsJSON returned error for empty string: %v", err)
	}
	if len(ids) != 0 {
		t.Fatalf("expected empty ids for empty string, got=%v", ids)
	}
}
