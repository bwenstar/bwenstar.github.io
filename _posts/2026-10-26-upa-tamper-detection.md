---
layout: post
title:  "Ten samples on one side: tamper detection for an in-wall intercom"
date:   2026-10-26 10:30:00 +1000
excerpt: "I needed a cheap way to tell when a wall-mounted help intercom had been tampered with. The answer was a six-axis IMU, a 2012 master's thesis about sirens, and a counter."
tags:   [embedded, go]
---

In 2022 I was asked to add tamper detection to an in-wall help intercom: the push-button
help points you see installed in prisons and in public places like South Bank in Brisbane. The
unit sits recessed in a wall, and the job was to know when someone had been at it (prying it
out, twisting it in its mounting) without adding much to the cost of the unit. The sensor I
used was an ST LSM6DSL, a small six-axis IMU (an accelerometer and a gyroscope in one
package), read by an embedded Linux board through the kernel's Industrial I/O drivers.

Sensing movement is the easy bit. A help point gets knocked, leaned on, slammed by doors and
shaken by passing trucks, and none of that should set off an alarm. The rule that worked came
from a 2012 master's thesis about tamper-proofing sirens: count consecutive samples that sit on
the same side of a threshold, and raise the alarm when the run gets too long.

This post covers the proof of concept, [UPA-tamper](https://github.com/brendan-ta/UPA-tamper),
written in Go in May 2022. The final version for the product's embedded system was a rewrite
and isn't public, but getting it working meant adding buffer support to an open-source Go
client for iiod, and that part is [below](#the-shipped-version-needed-a-library-fix). I've re-run the proof of concept's detector against samples I recorded from
the board at the time, and that harness is [at the end](#files) if you want to try it without
the hardware.

## What a still sensor looks like

Before any algorithm, I wanted to see what the gyroscope says when nothing is happening. A gyro
measures angular rate (how fast it's turning, in degrees per second), so a unit bolted into a
wall should read zero on all three axes. It doesn't. These are two captures I took off the
board's FIFO in March 2022 (raw little-endian 16-bit values, repeating X, Y, Z), with the unit
sitting still:

```
cap1000   1,000 frames
  X  mean 162.6  sd 11.3  min  126  max  198
  Y  mean -61.3  sd 12.5  min -103  max  -19
  Z  mean -131.5 sd  9.3  min -164  max -106
cap10000  10,000 frames
  X  mean 162.8  sd 10.5  min  127  max  206
  Y  mean -61.0  sd 12.7  min -113  max  -12
  Z  mean -131.2 sd  9.0  min -161  max  -89
```

{% include upa/rest.html %}

Each axis has its own fixed offset with about ten counts of noise on top. ST's datasheet calls
the offset the zero-rate level and gives it as ±3 dps (degrees per second) typical, so it's
normal, and it varies from part to part. Anything that compares readings against zero
will be wrong by a different amount on every unit. The detector has to learn each unit's
resting value first.

## The first attempt: compare two averages

My first go, a Python script that's still on this site as
[`fifo-iio/stdev-calc.py`](/fifo-iio/stdev-calc.py), did exactly that and not much else. For
each axis it collected 138 samples (about a second, at the 416 Hz the script assumes), took
the mean and standard deviation as the "normal" range, then checked whether the next second's
mean fell outside it:

```python
def setFirstAvgDeviation(self):
    if len(self.firstSet) >= self.numSamples:          # 138 samples
        self.firstAvg = statistics.mean(self.firstSet)
        calc_stdev = statistics.pstdev(self.firstSet)
        self.firstMax = self.firstAvg + calc_stdev       # normal = mean ± 1 sd
        self.firstMin = self.firstAvg - calc_stdev
```

It's a test of "did the average move", decided once every two seconds, with a threshold set by
the noise of whichever unit it's running on. Nothing in it describes what tampering actually
looks like compared with a knock. (It also has a step that was meant to throw away the first
36 samples and never runs, because `p.decDiscard` and `p.boolDiscard` are missing their
brackets.) Looking for something better is how I found the thesis.

## Somebody had been here before

[*Tamper Sensing using Low-Cost Accelerometers*](http://www.diva-portal.org/smash/get/diva2:538868/FULLTEXT01.pdf)
is Tobias Rådeskog's 2012 master's thesis from KTH in Stockholm, done with a security equipment
maker. Its problem is close to mine. Industry specs say a siren must raise a tamper warning if
it's moved from its mounting, and the usual way to detect that is a mechanical switch between
siren and wall, which the thesis points out can be defeated with a thin blade. Could a cheap MEMS
accelerometer (a Freescale MMA8451Q) and an 8-bit PIC microcontroller do better?

What I liked about it is the method. Instead of starting from signal-processing theory, the
author mounted the hardware on real surfaces (a fridge door, gypsum and concrete walls, near
hi-fi systems and machinery) and recorded what benign and malicious movement look like. The
conclusion is in section 4.4:

> Benign disturbance types show a lack of persistent unipolar deviation from the equilibrium
> point and tend to be quite transient in nature.

A knock makes the wall ring, and the reading swings back and forth around its resting value.
Pulling the unit off the wall pushes the reading to one side and keeps it there. So the thesis
proposes the *Unipolar Persistent Acceleration* (UPA) detector. For each axis, after subtracting
the resting value, classify every sample against a threshold τu:

```
T(x) =  1    if x >  τu
        0    if −τu ≤ x ≤ τu
       −1    if x < −τu
```

Count how many consecutive samples have the same non-zero T. Any sample back inside the band
resets the count. If the count passes τp samples on any one axis, raise the alarm.

{% include upa/knock-vs-turn.html %}

So the detector is just a comparison and a counter per axis, cheap enough for an 8-bit
microcontroller. The thesis settles on τu = 60 counts (3.7 mg) and τp = 7 samples
(140 ms at 50 Hz). It also pairs UPA with a second detector for drilling, which shakes the unit
hard but doesn't push it one way. I didn't implement that one.

## Using the gyroscope instead

The thesis is written for an accelerometer. I ran UPA on the LSM6DSL's gyroscope, with the
accelerometer switched off, and the idea carries over well. At rest the gyro reads its
zero-rate offset whatever way up the unit is, so "subtract the resting value" is just the offset
from the captures above. The accelerometer version has to subtract gravity, which changes with
orientation. Twisting a unit or levering one edge out of the wall turns it in one direction
for a while: one-sided and persistent. Vibration from a knock or a slammed door turns it back
and forth.

The sensor ran at its most sensitive range, ±125 dps, where one count is 4.375 millidegrees
per second, with a 52 Hz output rate.

## Getting samples out of the kernel

On Linux the LSM6DSL is an Industrial I/O (IIO) device. IIO is the kernel subsystem for
sensors and converters. Configuration lives in sysfs, and buffered samples come out of a
character device, here `/dev/iio:device1`.

{% include upa/pipeline.html %}

The board's driver exposed the gyro's FIFO controls
as sysfs attributes, and I used symlinks to them in `/var/volatile/udev/` to keep the paths
short. The program's start-up is a sequence of writes to those files:

```go
func tamperStartup() error {
    err := disableGyroFifo()        // gyro_fifo_enable   = 0
    ...
    err = enableGyroAxes()          // gyro_{x,y,z}_enable = 1
    ...
    err = setBufferDefaults()       // length 72, then watermark 12
    ...
    err = enableGyroFifo()          // gyro_fifo_enable   = 1
```

The length goes first because the watermark has to be smaller than it. With all three axes on,
one frame is 6 bytes (2 bytes per axis). I picked a watermark of 12 for two frames per
interrupt, and a length of 72 because 72 divides evenly by 6, 4 and 2, so it still fits whole
frames if one or two axes are switched off.

{% include upa/frame.html %}

Reading is a loop over the character device. Each frame is three little-endian signed 16-bit
values, and the code tracks which axis comes next. That tracking is rudimentary: it assumes the
first value it ever reads is X, and it skips any read that isn't exactly one 6-byte frame, so it
relies on the driver handing over one frame per read.

```go
// Data is little endian s16 therefore it is the following:
//  Gx = 01010110 01110100 => 0x5674 => 22132
if bytesread != BufferSize {          // BufferSize = 6
    logger.Printf("Skipping... Bytes read: %d, Expected %d\n", bytesread, BufferSize)
    continue
}
```

## The detector

Each axis gets its own state, and every sample goes through `performUpa`: add it to a running
total, set the baseline once there are enough samples, then check it.

```go
func (self *Axis) upaInit() {
    // Only generate our Min/Max value when one does not exist and once we have enough samples
    if self.NumSamples >= self.UpaVals.MaxSamples && self.MinVal == 0 && self.MaxVal == 0 {
        // the mean of the first 20 samples, ± τu
        var average int16 = self.Total / int16(self.NumSamples)
        self.MinVal = average - int16(self.UpaVals.Threshold)
        self.MaxVal = average + int16(self.UpaVals.Threshold)
```

```go
    if val > self.MaxVal {
        self.pCount++    // another sample above the band
        self.nCount = 0
    } else if val < self.MinVal {
        self.pCount = 0
        self.nCount++    // another sample below it
    } else {
        self.pCount = 0  // back inside: start again
        self.nCount = 0
    }

    if self.pCount >= self.UpaVals.MaxWindow || self.nCount >= self.UpaVals.MaxWindow {
        self.NumTamper++
        fmt.Printf("%s axis **** TAMPER #: %d **** \n", self.AxisName, self.NumTamper)
        playTone(self.Alert)
        self.MinVal = 0  // forget the baseline, learn a new one
        ...
```

`pCount` and `nCount` are the thesis's counter, split by sign. The three knobs are flags:
`-avg-samples` (20) for the baseline, `-max-window` (10) for τp, and `-threshold` (1) for τu.
The threshold is a percentage of 0xFFFF, so the default works out to
`floor(0.01 × 65535) = 655` counts. In real units:

- τu = 655 counts × 4.375 mdps ≈ **2.9°/s** of rotation on one axis
- τp = 10 samples at 52 Hz ≈ **190 ms**

So an alarm needs the unit turning faster than about 2.9°/s for a fifth of a second, which is at
least half a degree of actual rotation. Timing-wise that's close to the thesis's 140 ms. With
`-play-tone`, an alarm also plays a WAV file through `aplay`.

## Running it again without the hardware

The detector's functions don't care where their numbers come from, so the March captures are
enough to run it again without the board. The [harness](#files) is a Go test file that sits
next to `main.go` and calls `performUpa` directly. First, both captures through all three axes
with the default settings:

```
cap1000 X: band -495..815, tampers 0
cap1000 Y: band -713..597, tampers 0
cap1000 Z: band -783..527, tampers 0
cap10000 X: band -495..815, tampers 0
cap10000 Y: band -713..597, tampers 0
cap10000 Z: band -786..524, tampers 0
```

No alarms in 10,000 frames, and that isn't surprising: the noise swings about ±50 counts and
the band is ±655. (The captures were taken for the earlier script, so treat this as a check
that a still unit stays quiet, not a measured false-alarm rate.)

Then a simulated turn: rest at the X axis's 163-count offset, turn at a steady rate for two
seconds (104 samples), rest again. At 600 counts (2.6°/s) nothing happens, because it's under
the threshold. At 700 counts (3.1°/s):

```
X: Avg: 163 (Thres: 655), Min: -492, Max: 818
X: Max, p: 1, val: 863 > max: 818, count: 41
...
X: Max, p: 10, val: 863 > max: 818, count: 50
X axis **** TAMPER #: 1 ****
X: Avg: 863 (Thres: 655), Min: 208, Max: 1518      ; new baseline, learnt mid-turn
X: Min, n: 1, val: 163 < min 208, count: 95        ; the turn has stopped
...
X axis **** TAMPER #: 2 ****
X: Avg: 163 (Thres: 655), Min: -492, Max: 818      ; back to the resting baseline
```

{% include upa/turn.html %}

One turn, two alarms. The first fires ten samples into the turn. The detector then learns a new
baseline from the next 20 samples while the unit is still turning, so when the turn stops, the
resting value is *below* the new band and fires again. For a tamper alarm that's arguably a
feature (it reports when the movement started and when it stopped), but it isn't what the code
comment says ("recalculate rolling average"). The thesis re-calibrates only when every sample in
the window stays close to the first, and abandons the attempt otherwise.

## The bug: a 16-bit running total

A faster turn shows something worse. At 30°/s (6,857 counts), still well inside the ±125 dps
range:

```
X axis **** TAMPER #: 1 ****
X: Avg: 466 (Thres: 655), Min: -189, Max: 1121     ; the unit is reading 7020
X axis **** TAMPER #: 2 ****
X: Avg: 466 (Thres: 655), Min: -189, Max: 1121
X axis **** TAMPER #: 3 ****
X: Avg: 466 (Thres: 655), Min: -189, Max: 1121
X axis **** TAMPER #: 4 ****
X: Avg: -713 (Thres: 655), Min: -1368, Max: -58
X axis **** TAMPER #: 5 ****
```

The re-learnt baseline is 466 while every sample is 7,020. `Total` is an `int16`, and twenty
samples of 7,020 add up to 140,400. Go integers wrap silently, so that comes out as
140,400 − 2 × 65,536 = 9,328, and 9,328 / 20 = 466. Any 20-sample window averaging more than
32,767 / 20 ≈ 1,638 counts (about 7.2°/s) overflows the same way. Here it fails loud, with five
alarms instead of two, so nothing gets missed. But the baseline is garbage until the next reset,
and the fix is to make `Total` an `int`.

{% include upa/overflow.html %}

At rest it never shows up, because twenty samples of 163 is 3,260. The total also keeps
growing (and wrapping) after the baseline is set, which doesn't matter because it's only read
once.

## The shipped version needed a library fix

The product version doesn't read sysfs or the character device. It talks to iiod, the IIO
daemon from Analog Devices' [libiio](https://github.com/analogdevicesinc/libiio), which serves
a device's attributes and sample buffers over a simple text protocol on a TCP socket. The UPA
calculation stayed much the same; only the plumbing changed, which is the bottom lane of the
diagram in the kernel section above.

To do that from Go I used [goiio](https://github.com/jonkerj/goiio), a small iiod client. In
May 2022 it could fetch the device context and read attribute values, but it couldn't open a
buffer, and a buffer is the only way to stream FIFO samples. So I added it, and my pull
request ([#4](https://github.com/jonkerj/goiio/pull/4), merged in June 2022) has three
commits:

- **Buffer support.** `CreateBuffer`, `DumpBuffer` and `DestroyBuffer` wrap iiod's `OPEN`,
  `READBUF` and `CLOSE` commands. `READBUF` replies differently from everything else the client
  handled: a size line, a line with the channel mask, and then the raw sample bytes, so it got
  its own reader (`bufferSizedReply`).
- **A hang on empty replies.** iiod answers `OPEN` with just `0`: a length and no body. The
  client always read a second line after the length, so it sat waiting for a line that never
  came. The fix treats a zero length as success with an empty reply:

  ```go
  reply := ""
  if size < 0 {
      return nil, fmt.Errorf("received negative size (error) from remote: %d", size)
  } else if size == 0 {
      return &reply, nil      // e.g. OPEN: "0\n" and nothing after it
  }

  reply, err = i.reader.ReadString('\n')
  ```

- **`Close()`**, to shut the TCP connection down cleanly.

{% include upa/iiod.html %}

With those in, a program can open the gyro's buffer through iiod, pull frames out with
`READBUF`, and feed them to per-axis UPA code much like the code above.

## Loose ends

- **A gyro can't see a straight pull.** Sliding the unit straight out of the wall without
  turning it produces no angular rate at all. The accelerometer would see it, and that's the
  sensor the thesis built UPA for. The LSM6DSL has both, and this proof of concept only uses
  one.
- **No drilling detector.** The thesis's second detector, for sustained high-energy shaking, is
  what catches a drill. I didn't build it.
- **The first baseline is taken on trust.** The program averages whatever its first 20 samples
  are. If the unit is moving at start-up, every later comparison is off. The thesis's
  "cancel calibration if any sample strays" check would fix this and the double alarm above.
- **The general lesson.** My first attempt measured how *much* the signal moved. The thesis
  asks what *shape* tampering has compared with everything else that happens to a wall, and
  once you know that, the detector is a comparison and a counter that runs on almost anything.

## Files

**[Download upa-check.zip](/assets/downloads/upa-tamper/upa-check.zip)** (37 KB). It holds the
test harness, both captures and a README. Clone the project, copy the files into it, and run the
tests:

```bash
git clone https://github.com/brendan-ta/UPA-tamper
cp upa-check/upa_test.go upa-check/cap1000 upa-check/cap10000 UPA-tamper/
cd UPA-tamper
go mod init upa-tamper      # the repo has no go.mod, and go build won't run without one
go test -v
```

- [`upa_test.go`](/assets/downloads/upa-tamper/upa_test.go): `TestCaptures` (both captures, all
  three axes), `TestTurn` (2.6, 3.1 and 30°/s) and `TestFigure` (writes the `figure.csv` behind
  the figure above). It calls the detector in `main.go` directly, so it tests the real code, not
  a copy.
- [`cap1000`](/fifo-iio/cap1000) (6 KB) and [`cap10000`](/fifo-iio/cap10000) (59 KB): the
  resting captures from the board.
- **[UPA-tamper](https://github.com/brendan-ta/UPA-tamper)** itself needs the LSM6DSL, an IIO
  driver and the sysfs links described above. On other hardware the paths in `helper.go` will be
  different.

Tested with Go 1.18 (the `golang:1.18-alpine` Docker image). The harness needs no hardware.
