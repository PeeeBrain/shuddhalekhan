import UIKit

@main
struct ActivityPublicationCheck {
  @MainActor static func main() {
    let app = UIApplication.shared
    let publication = ActivityPublication()
    precondition(app.activeTasks == 1, "Audio background execution alone cannot publish ActivityKit updates")
    publication.end()
    publication.end()
    precondition(app.activeTasks == 0)

    let expiring = ActivityPublication()
    precondition(app.activeTasks == 1)
    app.expirationHandler?()
    precondition(app.activeTasks == 0, "An expired publication must release its assertion before suspension")
    expiring.end()

    app.grantsBackgroundTime = false
    let denied = ActivityPublication()
    denied.end()
    precondition(app.activeTasks == 0, "Denied background time must never be ended as a valid assertion")

    app.applicationState = .active
    let requests = app.requests
    let foreground = ActivityPublication()
    foreground.end()
    precondition(app.requests == requests, "Foreground publication needs no background assertion")
    print("Activity publication assertion, expiration and foreground checks passed.")
  }
}
