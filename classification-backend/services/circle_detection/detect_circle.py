import cv2
import numpy as np


def detect_circles(image_path):
    """
    Detect circles in an image and determine whether each circle is filled or not.
    Returns a list of results and the annotated image.
    """

    img = cv2.imread(image_path)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)

    # Initialize results so function always returns a list
    results = []

    # Detect circles (Hough Transform)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,  # resolution ratio
        minDist=50,  # minimum distance between circles
        param1=85,  # Canny edge parameter
        param2=85,  # sensitivity: smaller -> more circles
        minRadius=5,
        maxRadius=500,
    )

    if circles is not None:
        circles = np.uint16(np.around(circles[0, :]))

        for x, y, r in circles:
            # Extract circle region
            mask = np.zeros_like(gray)
            cv2.circle(mask, (x, y), r, 255, -1)
            mean_inside = cv2.mean(gray, mask=mask)[0]

            # Ring mask (edge)
            ring = np.zeros_like(gray)
            cv2.circle(ring, (x, y), r, 255, 2)
            mean_edge = cv2.mean(gray, mask=ring)[0]

            # Decision: filled or not?
            filled = abs(mean_inside - mean_edge) < 20  # threshold adjustable
            fill_state = "filled" if filled else "unfilled"

            results.append(
                {"x": int(x), "y": int(y), "radius": int(r), "status": fill_state}
            )

            # Visualization
            color = (0, 255, 0) if filled else (0, 0, 255)
            cv2.circle(img, (x, y), r, color, 2)
            cv2.circle(img, (x, y), 2, (255, 0, 0), 3)

        print("Detected circles:")
        for res in results:
            print(res)

    else:
        print("No circles found.")

    return results, img
