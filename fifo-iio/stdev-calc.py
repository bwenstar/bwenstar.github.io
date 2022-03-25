#!/usr/bin/env python3

import os
import io
import struct
import subprocess
import math
import statistics

# 3 = x, y, z
FIFO_SAMPLES=3

# 1 frame = 3 samples
FIFO_WATERMARK=12

DISCARD_SAMPLES=FIFO_SAMPLES*FIFO_WATERMARK

ANG_PATH="/sys/devices/soc0/soc/2100000.aips-bus/21a0000.i2c/i2c-0/0-006a/iio:device1"

# Num sample per buffer
# 416hz -> 416 samples a second
#       -> ~138 samples of each axis per second
# Check tamper every 2 seconds per axis; (1s) one base, (1s) one test
# Gx: 138, Gy: 138, Gz: 138 = 414 samples per second
NUM_SAMPLES=138

# Print to stdout
TAMPER_OUT = True
#TAMPER_OUT = False

# Output for matplotlib
#PLOT_OUT = True
PLOT_OUT = False

class Axis:
    def __init__(self, name):
        self.name = name
        self.firstSet = []
        self.secondSet = []
        self.firstAvg = None
        self.secondAvg = None
        self.firstMin = None
        self.firstMax = None
        self.numSamples = NUM_SAMPLES
        self.scalingFactor = obtain_scale()

    def clearFirstSet(self):
        self.firstSet = []

    def clearSecondSet(self):
        self.secondSet = []

    def clearData(self):
        self.firstSet = []
        self.secondSet = []
        self.firstAvg = None
        self.secondAvg = None
        self.firstMin = None
        self.firstMax = None

    def firstSetAppend(self, val):
        self.firstSet.append(val)

    def secondSetAppend(self, val):
        self.secondSet.append(val)

    def setFirstValues(self, average, min, max):
        self.firstAvg = average
        self.firstMin = min
        self.firstMax = max

    def setFirstAvg(self, val):
        self.FirstAvg = val

    def setSecondAvg(self, val):
        self.secondAvg = val

    def setFirstMin(self, val):
        self.firstMin = val

    def setFirstMax(self, val):
        self.firstMax = val

    def setFirstAvgDeviation(self):
        if len(self.firstSet) >= self.numSamples:
            self.firstAvg = statistics.mean(self.firstSet)
            calc_stdev = statistics.pstdev(self.firstSet)
            self.firstMax = self.firstAvg + calc_stdev
            self.firstMin = self.firstAvg - calc_stdev
            #print("{}, [{}], Average: {}, Stdev: {}, Min: {}, Max: {}".format(self.name, self.firstSet, self.firstAvg, calc_stdev, self.firstMin, self.firstMax))
            return True
        else:
            return False

    def setCheckSecondAvg(self):
        if len(self.secondSet) >= self.numSamples:
            self.secondAvg = statistics.mean(self.secondSet)
            #print("{}, [{}], Average: {}".format(self.name, self.secondSet, self.secondAvg))
            return True
        else:
            return False

    def compareThresholdsMinMax(self):
        if self.secondAvg > self.firstMax:
            if TAMPER_OUT: print("{} Alert MAX (Min: {}, Val: {}, Max: {})".format(self.name, self.firstMin, self.secondAvg, self.firstMax))
            return True
        if self.secondAvg < self.firstMin:
            if TAMPER_OUT: print("{} Alert MIN (Min: {}, Val: {}, Max: {})".format(self.name, self.firstMin, self.secondAvg, self.firstMax))
            return True
        if TAMPER_OUT: print("{}: Okay".format(self.name))
        return False

class Plot:
    def __init__(self):
        # Dictionary to keep values in place
        # i.e. {i: '1', {x: '111', y: '222', z: '333'}}
        self.values = {}
        self.numSamples = []
        self.numFrames = 1
        self.xValues = []
        self.yValues = []
        self.zValues = []
        self.numDiscard = DISCARD_SAMPLES
        self.skip = True
        self.count = 1
        self.loop = True
        self.xAlert = []
        self.yAlert = []
        self.zAlert = []
        self.xNumAlert = 0
        self.yNumAlert = 0
        self.zNumAlert = 0

    def xAppend(self, val):
        #self.numSamples.append(self.numFrames)
        self.xValues.append(val)
        self.values[self.numFrames] = {}
        self.values[self.numFrames]['x'] = val
        self.setSkipTrue()

    def yAppend(self, val):
        #self.numSamples.append(self.numFrames)
        self.yValues.append(val)
        self.values[self.numFrames]['y'] = val
        self.setSkipTrue()

    def zAppend(self, val):
        self.numSamples.append(self.numFrames)
        self.zValues.append(val)
        self.values[self.numFrames]['z'] = val
        self.numFrames = self.numFrames + 1
        self.setSkipTrue()

    def outputForPlotting(self):
        print("i = [{}]\n".format(str(self.numSamples)[1:-1]))
        print("x_raw = [{}]\n".format(str(self.xValues)[1:-1]))
        print("y_raw = [{}]\n".format(str(self.yValues)[1:-1]))
        print("z_raw = [{}]\n".format(str(self.zValues)[1:-1]))
        print("x_alert = [{}]\n".format(str(self.xAlert)[1:-1]))
        print("y_alert = [{}]\n".format(str(self.yAlert)[1:-1]))
        print("z_alert = [{}]\n".format(str(self.zAlert)[1:-1]))
        print("x_numalerts = {}\n".format(self.xNumAlert))
        print("y_numalerts = {}\n".format(self.yNumAlert))
        print("z_numalerts = {}\n".format(self.zNumAlert))

    def decDiscard(self):
        self.numDiscard = self.numDiscard - 1

    def boolDiscard(self):
        if self.numDiscard == 0:
            return True
        else:
            return False

    def setSkipFalse(self):
        self.skip = False

    def setSkipTrue(self):
        self.skip = True

    def setLoopFalse(self):
        self.loop = False

    def setXAlert(self, val):
        self.xAlert.append(val)

    def setYAlert(self, val):
        self.yAlert.append(val)

    def setZAlert(self, val):
        self.zAlert.append(val)

    def incXNumAlert(self):
        self.xNumAlert = self.xNumAlert + 1

    def incYNumAlert(self):
        self.yNumAlert = self.yNumAlert + 1

    def incZNumAlert(self):
        self.zNumAlert = self.zNumAlert + 1


def obtain_scale():
    sp = subprocess.run(["cat", "{}/{}".format(ANG_PATH, "in_anglvel_scale")],
                          stdout=subprocess.PIPE)
    ret = sp.stdout.decode('utf-8').strip()
    return(float(ret))

with open('/dev/iio:device1', mode='rb', buffering=-1, encoding=None) as line:

    fio = io.FileIO(line.fileno())
    fbuf = io.BufferedReader(fio)

    counter = 0

    x_bool = False
    y_bool = False
    z_bool = False

    p = Plot()
    xaxis = Axis("X")
    yaxis = Axis("Y")
    zaxis = Axis("Z")

    while p.loop:
        try:
            p.setSkipFalse()
            try:
                out1 = fbuf.read(2)
            except KeyboardInterrupt:
                break
            if not out1:
                break

            out = struct.unpack('h', out1)
            #print(out[0])

            # X
            if p.boolDiscard and counter == 0 and not p.skip:
                x_val = out[0]
                #x_val = out[0]*scalar
                p.xAppend(x_val)
                #print(x_val)

                # check for average of first set of data
                # after num_samples reached, we have firstSet mean, min(mean-stdev), max (mean+stdev)
                if not xaxis.firstAvg:
                    xaxis.firstSetAppend(x_val)
                    xaxis.setFirstAvgDeviation()
                # second set of data
                else:
                    xaxis.secondSetAppend(x_val)
                    xaxis.setCheckSecondAvg()
                # compare second set average against min and max of first set
                if xaxis.firstAvg and xaxis.secondAvg:
                    x_bool = xaxis.compareThresholdsMinMax()
                    if x_bool:
                        p.setXAlert(xaxis.secondAvg)
                        p.incXNumAlert()
                    else:
                        p.setXAlert(None)
                    xaxis.clearData()
                    x_bool = False
                else:
                    p.setXAlert(None)

                # Next capture is Y
                counter = counter + 1

            # Y
            if p.boolDiscard and counter == 1 and not p.skip:
                y_val = out[0]
                #y_val = out[0]*scalar
                p.yAppend(y_val)
                #print(y_val)

                if not yaxis.firstAvg:
                    yaxis.firstSetAppend(y_val)
                    yaxis.setFirstAvgDeviation()
                else:
                    yaxis.secondSetAppend(y_val)
                    yaxis.setCheckSecondAvg()
                if yaxis.firstAvg and yaxis.secondAvg:
                    y_bool = yaxis.compareThresholdsMinMax()
                    if y_bool:
                        p.setYAlert(yaxis.secondAvg)
                        p.incYNumAlert()
                    else:
                        p.setYAlert(None)
                    yaxis.clearData()
                    y_bool = False
                else:
                    p.setYAlert(None)

                # Next capture is Z
                counter = counter + 1

            # Z
            if p.boolDiscard and counter == 2 and not p.skip:
                z_val = out[0]
                p.zAppend(z_val)
                #print(z_val)

                if not zaxis.firstAvg:
                    zaxis.firstSetAppend(z_val)
                    zaxis.setFirstAvgDeviation()
                else:
                    zaxis.secondSetAppend(z_val)
                    zaxis.setCheckSecondAvg()
                if zaxis.firstAvg and zaxis.secondAvg:
                    z_bool = zaxis.compareThresholdsMinMax()
                    if z_bool:
                        p.setZAlert(zaxis.secondAvg)
                        p.incZNumAlert()
                    else:
                        p.setZAlert(None)
                    zaxis.clearData()
                    z_bool = False
                else:
                    p.setZAlert(None)

                # Next capture is X
                counter = 0

            # Discard fixed amount of results
            if p.numDiscard > 0:
                p.decDiscard

        except struct.error:
            p.setLoopFalse()

    # print to file for pylibmatlib
    if PLOT_OUT: print(p.outputForPlotting())

