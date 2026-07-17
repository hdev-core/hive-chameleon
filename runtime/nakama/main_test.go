package main

import "testing"

func TestModuleNameIsStable(t *testing.T) {
	t.Parallel()

	if moduleName != "hive_chameleon" {
		t.Fatalf("unexpected module name: %s", moduleName)
	}
}
