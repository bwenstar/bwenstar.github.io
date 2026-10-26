// Runs UPA-tamper's detector over recorded and simulated gyro samples, without the
// sensor. Copy this file and cap1000/cap10000 into a clone of
// https://github.com/brendan-ta/UPA-tamper and run: go test -v
package main

import (
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"testing"
)

// Defaults from main.go: -avg-samples 20, -max-window 10, -threshold 1 (655 counts).
func defaultAxis(name string) *Axis {
	return newAxis(name, *newTone("", false), *newUpa(20, 10, calcIntThreshold(1)))
}

// Feeds a capture (little-endian s16, Gx Gy Gz repeating) through all three axes.
func TestCaptures(t *testing.T) {
	logger = log.New(ioutil.Discard, "", 0)
	for _, name := range []string{"cap1000", "cap10000"} {
		d, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		ax := []*Axis{defaultAxis("X"), defaultAxis("Y"), defaultAxis("Z")}
		for i := 0; i+1 < len(d); i += 2 {
			ax[(i/2)%3].performUpa(convertToLeS16(uint16(d[i+1]), uint16(d[i])))
		}
		for _, a := range ax {
			t.Logf("%s %s: band %d..%d, tampers %d", name, a.AxisName, a.MinVal, a.MaxVal, a.NumTamper)
		}
	}
}

// Rest at a 163-count offset, turn at a steady rate for 104 samples (2 s at 52 Hz), rest.
// At +-125 dps one count is 4.375 mdps: 600 = 2.6 dps, 700 = 3.1 dps, 6857 = 30 dps.
func TestTurn(t *testing.T) {
	logger = log.New(os.Stdout, "", 0)
	for _, rate := range []int16{600, 700, 6857} {
		fmt.Printf("--- turn at +%d counts\n", rate)
		a := defaultAxis("X")
		for i := 0; i < 40; i++ {
			a.performUpa(163)
		}
		for i := 0; i < 104; i++ {
			a.performUpa(163 + rate)
		}
		for i := 0; i < 200; i++ {
			a.performUpa(163)
		}
		t.Logf("turn at +%d counts: %d tampers", rate, a.NumTamper)
	}
}

// The post's figure: X-axis samples from cap10000 with +700 counts added to samples 60-163.
func TestFigure(t *testing.T) {
	logger = log.New(ioutil.Discard, "", 0)
	d, err := os.ReadFile("cap10000")
	if err != nil {
		t.Fatal(err)
	}
	out, err := os.Create("figure.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	a := defaultAxis("X")
	fmt.Fprintln(out, "n,val,min,max,tamper")
	for n := 0; n < 300; n++ {
		v := convertToLeS16(uint16(d[n*6+1]), uint16(d[n*6]))
		if n >= 60 && n < 164 {
			v += 700
		}
		before := a.NumTamper
		a.performUpa(v)
		fmt.Fprintf(out, "%d,%d,%d,%d,%d\n", n, v, a.MinVal, a.MaxVal, a.NumTamper-before)
	}
}
